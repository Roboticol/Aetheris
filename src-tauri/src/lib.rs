use ignore::WalkBuilder;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Instant;
use tauri::{Emitter, Manager};
use tokio::sync::{oneshot, Mutex};

#[derive(Default)]
struct AgentCancelState {
    tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub kind: String, // "file" | "dir"
    pub children: Option<Vec<FileNode>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub file_path: String,
    pub line: usize,
    pub preview: String,
    pub symbol_kind: Option<String>,
    pub symbol_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFileContext {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPatch {
    pub path: String,
    pub action: String,
    pub rationale: String,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPlanResponse {
    pub summary: String,
    pub steps: Vec<String>,
    pub patches: Vec<AgentPatch>,
    pub thoughts: String,
    pub thinking_duration_ms: u64,
}

#[derive(Debug, Deserialize)]
struct LocalConfig {
    gemini_api_key: Option<String>,
}

#[cfg(target_os = "linux")]
fn ensure_linux_desktop_integration() {
    let Some(data_dir) = dirs::data_local_dir() else {
        return;
    };

    let icon_png_dir = data_dir
        .join("icons")
        .join("hicolor")
        .join("128x128")
        .join("apps");
    let icon_svg_dir = data_dir
        .join("icons")
        .join("hicolor")
        .join("scalable")
        .join("apps");
    let apps_dir = data_dir.join("applications");

    let _ = fs::create_dir_all(&icon_png_dir);
    let _ = fs::create_dir_all(&icon_svg_dir);
    let _ = fs::create_dir_all(&apps_dir);

    let png_path = icon_png_dir.join("aetheris.png");
    let svg_path = icon_svg_dir.join("aetheris.svg");

    let png_bytes = include_bytes!("../icons/icon.png");
    let svg_bytes = include_bytes!("../icons/icon.svg");
    let _ = fs::write(&png_path, png_bytes);
    let _ = fs::write(&svg_path, svg_bytes);

    let exe_cmd = std::env::current_exe()
        .ok()
        .map(|p| format!("{} %F", p.to_string_lossy()))
        .unwrap_or_else(|| "aetheris %F".to_string());

    let desktop_entry = format!(
        "[Desktop Entry]\nType=Application\nName=Aetheris\nComment=Lightweight Rust-native agentic coding IDE\nExec={}\nIcon={}\nTerminal=false\nCategories=Development;IDE;TextEditor;\nStartupNotify=true\nStartupWMClass=aetheris\n",
        exe_cmd,
        png_path.to_string_lossy()
    );

    // Cover both binary prgname (`aetheris`) and bundle identifier (`dev.aetheris.ide`) on Wayland taskbars
    let _ = fs::write(apps_dir.join("aetheris.desktop"), &desktop_entry);
    let _ = fs::write(apps_dir.join("dev.aetheris.ide.desktop"), &desktop_entry);

    let hicolor_root = data_dir.join("icons").join("hicolor");
    let _ = Command::new("gtk-update-icon-cache")
        .arg("-f")
        .arg("-t")
        .arg(&hicolor_root)
        .spawn();
    let _ = Command::new("update-desktop-database").arg(&apps_dir).spawn();
}

fn sanitize_relative_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err("Absolute paths are not allowed inside workspace".into());
    }
    for comp in rel_path.components() {
        if matches!(comp, Component::ParentDir) {
            return Err("Path traversal outside workspace root is prohibited".into());
        }
    }
    Ok(root.join(rel_path))
}

fn resolve_gemini_api_key() -> Result<String, String> {
    if let Ok(key) = std::env::var("GEMINI_API_KEY") {
        let trimmed = key.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }

    if let Ok(entry) = keyring::Entry::new("aetheris", "gemini_api_key") {
        if let Ok(secret) = entry.get_password() {
            let trimmed = secret.trim().to_string();
            if !trimmed.is_empty() {
                return Ok(trimmed);
            }
        }
    }

    if let Some(config_dir) = dirs::config_dir() {
        let cfg_path = config_dir.join("aetheris").join("config.toml");
        if let Ok(raw) = fs::read_to_string(cfg_path) {
            if let Ok(parsed) = toml::from_str::<LocalConfig>(&raw) {
                if let Some(key) = parsed.gemini_api_key {
                    let trimmed = key.trim().to_string();
                    if !trimmed.is_empty() {
                        return Ok(trimmed);
                    }
                }
            }
        }
    }

    Err("No Google AI Studio API key configured. Export GEMINI_API_KEY or save it in ~/.config/aetheris/config.toml.".into())
}

fn build_tree(dir: &Path, root: &Path, depth: usize) -> Result<Vec<FileNode>, String> {
    if depth > 10 {
        return Ok(vec![]);
    }
    let mut dirs_vec = Vec::new();
    let mut files_vec = Vec::new();

    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name != ".env.example" && name != ".gitignore" {
            continue;
        }
        if name == "node_modules" || name == "target" || name == "dist" {
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");

        if path.is_dir() {
            let children = build_tree(&path, root, depth + 1)?;
            dirs_vec.push(FileNode {
                name,
                path: rel,
                kind: "dir".into(),
                children: Some(children),
            });
        } else {
            files_vec.push(FileNode {
                name,
                path: rel,
                kind: "file".into(),
                children: None,
            });
        }
    }

    dirs_vec.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files_vec.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    dirs_vec.extend(files_vec);
    Ok(dirs_vec)
}

#[tauri::command]
fn list_workspace_tree(root: String) -> Result<Vec<FileNode>, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Workspace directory does not exist".into());
    }
    build_tree(&root_path, &root_path, 0)
}

#[tauri::command]
fn read_workspace_file(root: String, rel_path: String) -> Result<String, String> {
    let target = sanitize_relative_path(Path::new(&root), &rel_path)?;
    fs::read_to_string(target).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_workspace_file(root: String, rel_path: String, content: String) -> Result<(), String> {
    let target = sanitize_relative_path(Path::new(&root), &rel_path)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(target, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_workspace_entry(root: String, rel_path: String, kind: String) -> Result<(), String> {
    let target = sanitize_relative_path(Path::new(&root), &rel_path)?;
    if kind == "dir" {
        fs::create_dir_all(target).map_err(|e| e.to_string())
    } else {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(target, "").map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn rename_workspace_entry(root: String, old_path: String, new_path: String) -> Result<(), String> {
    let src = sanitize_relative_path(Path::new(&root), &old_path)?;
    let dst = sanitize_relative_path(Path::new(&root), &new_path)?;
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(src, dst).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_workspace_entry(root: String, rel_path: String) -> Result<(), String> {
    let target = sanitize_relative_path(Path::new(&root), &rel_path)?;
    if target.is_dir() {
        fs::remove_dir_all(target).map_err(|e| e.to_string())
    } else if target.exists() {
        fs::remove_file(target).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
fn search_workspace(root: String, query: String, symbols_only: bool) -> Result<Vec<SearchHit>, String> {
    let root_path = PathBuf::from(&root);
    let q_lower = query.trim().to_lowercase();
    let sym_re = Regex::new(
        r"^\s*(?:pub\s+)?(?:async\s+)?(?:export\s+)?(?:default\s+)?(fn|struct|enum|trait|impl|function|class|interface|type|const|def)\s+([A-Za-z_][A-Za-z0-9_]*)",
    )
    .map_err(|e| e.to_string())?;

    let mut hits = Vec::new();
    let walker = WalkBuilder::new(&root_path)
        .hidden(true)
        .git_ignore(true)
        .build();

    for result in walker.flatten() {
        let path = result.path();
        if !path.is_file() {
            continue;
        }
        let Ok(content) = fs::read_to_string(path) else {
            continue;
        };
        let rel = path
            .strip_prefix(&root_path)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");

        for (idx, line) in content.lines().enumerate() {
            if hits.len() >= 150 {
                return Ok(hits);
            }
            if let Some(caps) = sym_re.captures(line) {
                let kind = caps.get(1).map(|m| m.as_str().to_string());
                let name = caps.get(2).map(|m| m.as_str().to_string());
                let matches_query = q_lower.is_empty()
                    || name
                        .as_deref()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(&q_lower)
                    || line.to_lowercase().contains(&q_lower);
                if matches_query {
                    hits.push(SearchHit {
                        file_path: rel.clone(),
                        line: idx + 1,
                        preview: line.trim().chars().take(140).collect(),
                        symbol_kind: kind,
                        symbol_name: name,
                    });
                }
            } else if !symbols_only && !q_lower.is_empty() && line.to_lowercase().contains(&q_lower) {
                hits.push(SearchHit {
                    file_path: rel.clone(),
                    line: idx + 1,
                    preview: line.trim().chars().take(140).collect(),
                    symbol_kind: None,
                    symbol_name: None,
                });
            }
        }
    }

    Ok(hits)
}

#[tauri::command]
async fn exec_terminal_command(root: String, command: String) -> Result<TerminalOutput, String> {
    let root_path = PathBuf::from(&root);
    let output = tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        let out = Command::new("cmd")
            .args(["/C", &command])
            .current_dir(&root_path)
            .output();

        #[cfg(not(target_os = "windows"))]
        let out = Command::new("sh")
            .args(["-c", &command])
            .current_dir(&root_path)
            .output();

        out
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    Ok(TerminalOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(1),
    })
}

#[tauri::command]
fn save_desktop_api_key(api_key: String) -> Result<(), String> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err("API key cannot be empty".into());
    }
    if let Ok(entry) = keyring::Entry::new("aetheris", "gemini_api_key") {
        if entry.set_password(trimmed).is_ok() {
            return Ok(());
        }
    }
    if let Some(config_dir) = dirs::config_dir() {
        let dir = config_dir.join("aetheris");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let body = format!("gemini_api_key = {:?}\n", trimmed);
        fs::write(dir.join("config.toml"), body).map_err(|e| e.to_string())?;
        return Ok(());
    }
    Err("Unable to persist API key to keyring or config directory".into())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurnInput {
    pub role: String,
    pub content: String,
}

#[tauri::command]
fn create_new_workspace_dir(parent_dir: String, name: String) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.contains('/') || trimmed.contains('\\') || trimmed == ".." {
        return Err("Invalid folder name".into());
    }
    let target = PathBuf::from(&parent_dir).join(trimmed);
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
async fn chat_gemini(messages: Vec<ChatTurnInput>) -> Result<String, String> {
    let api_key = resolve_gemini_api_key()?;
    let client = reqwest::Client::new();

    let contents: Vec<serde_json::Value> = messages
        .into_iter()
        .map(|m| {
            let role = if m.role == "assistant" { "model" } else { "user" };
            serde_json::json!({
                "role": role,
                "parts": [{ "text": m.content }]
            })
        })
        .collect();

    let body = serde_json::json!({
        "systemInstruction": {
            "parts": [{
                "text": "You are Aetheris, a friendly, concise coding companion inside a lightweight Rust-native IDE. Answer quick questions, chat naturally, or help brainstorm ideas cleanly."
            }]
        },
        "contents": contents,
        "generationConfig": {
            "thinkingConfig": { "thinkingLevel": "LOW" }
        }
    });

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent?key={}",
        api_key
    );

    let res = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error contacting Gemini API: {}", e))?;

    if !res.status().is_success() {
        let txt = res.text().await.unwrap_or_default();
        return Err(format!("Gemini API error: {}", txt));
    }

    let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let reply = json["candidates"][0]["content"]["parts"]
        .as_array()
        .and_then(|parts| parts.iter().rev().find_map(|p| p["text"].as_str()))
        .ok_or_else(|| "Empty response from Gemini API".to_string())?;

    Ok(reply.to_string())
}

#[tauri::command]
async fn cancel_gemini_agent(state: tauri::State<'_, AgentCancelState>) -> Result<(), String> {
    let mut guard = state.tx.lock().await;
    if let Some(tx) = guard.take() {
        let _ = tx.send(());
    }
    Ok(())
}

#[tauri::command]
async fn run_gemini_agent(
    app: tauri::AppHandle,
    state: tauri::State<'_, AgentCancelState>,
    prompt: String,
    active_file: Option<String>,
    files: Vec<AgentFileContext>,
    effort: Option<String>,
    agent_mode: Option<String>,
    history: Option<Vec<ChatTurnInput>>,
) -> Result<AgentPlanResponse, String> {
    let api_key = resolve_gemini_api_key()?;
    let client = reqwest::Client::new();
    let started_at = Instant::now();

    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    {
        let mut guard = state.tx.lock().await;
        if let Some(prev) = guard.take() {
            let _ = prev.send(());
        }
        *guard = Some(cancel_tx);
    }

    let is_plan_mode = agent_mode.as_deref() == Some("plan");
    let thinking_level = match effort.as_deref() {
        Some("xhigh") => "XHIGH",
        Some("high") => "HIGH",
        Some("low") => "LOW",
        _ => "MEDIUM",
    };

    let mut inspected: Vec<String> = Vec::new();
    if let Some(ref af) = active_file {
        inspected.push(af.clone());
    }
    for f in &files {
        if inspected.len() >= 4 {
            break;
        }
        if !inspected.contains(&f.path) {
            inspected.push(f.path.clone());
        }
    }
    for fp in inspected {
        let _ = app.emit(
            "aetheris-agent-event",
            serde_json::json!({
                "type": "activity",
                "activity": {
                    "id": format!("read-{}", fp),
                    "kind": "read",
                    "label": format!("Inspecting {}", fp),
                    "filePath": fp,
                    "status": "done"
                }
            }),
        );
    }

    let _ = app.emit(
        "aetheris-agent-event",
        serde_json::json!({
            "type": "activity",
            "activity": {
                "id": "phase-think",
                "kind": "think",
                "label": if is_plan_mode { "Analyzing architecture & plan" } else { "Reasoning over workspace edits" },
                "status": "running"
            }
        }),
    );

    let mut context_block = String::new();
    for f in files.iter().take(28) {
        let slice: String = f.content.chars().take(18000).collect();
        context_block.push_str(&format!("\n--- FILE: {} ---\n{}\n", f.path, slice));
    }

    let system_prompt = if is_plan_mode {
        "You are Aetheris in PLAN MODE (read-only). Analyze the workspace files and produce a structured engineering plan as JSON with: summary (technical findings and design overview), steps (detailed ordered implementation steps citing exact file paths and symbols), and patches (MUST be an empty array [] in Plan Mode—do not emit file modifications)."
    } else {
        "You are Aetheris in ACTION MODE. Inspect the provided workspace files and return JSON with summary, steps (array of strings), and patches (array of {path, action: create|modify|delete, rationale, content}). Always provide complete updated file content when action is create or modify."
    };

    let mut contents: Vec<serde_json::Value> = history
        .unwrap_or_default()
        .into_iter()
        .filter(|h| !h.content.trim().is_empty())
        .rev()
        .take(10)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|h| {
            let role = if h.role == "assistant" { "model" } else { "user" };
            let clipped: String = h.content.chars().take(4000).collect();
            serde_json::json!({
                "role": role,
                "parts": [{ "text": clipped }]
            })
        })
        .collect();

    let user_msg = format!(
        "Mode: {}\nActive file: {}\nUser request: {}\nWorkspace files:{}",
        if is_plan_mode { "PLAN" } else { "ACTION" },
        active_file.unwrap_or_else(|| "none".into()),
        prompt,
        context_block
    );
    contents.push(serde_json::json!({
        "role": "user",
        "parts": [{ "text": user_msg }]
    }));

    let body = serde_json::json!({
        "systemInstruction": { "parts": [{ "text": system_prompt }] },
        "contents": contents,
        "generationConfig": {
            "responseMimeType": "application/json",
            "thinkingConfig": {
                "thinkingLevel": thinking_level,
                "includeThoughts": true
            }
        }
    });

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:streamGenerateContent?alt=sse&key={}",
        api_key
    );

    let send_fut = client.post(&url).json(&body).send();
    let mut res = tokio::select! {
        _ = &mut cancel_rx => {
            return Err("CANCELLED".into());
        }
        r = send_fut => {
            r.map_err(|e| format!("Network error contacting Gemini API: {}", e))?
        }
    };

    if !res.status().is_success() {
        let txt = res.text().await.unwrap_or_default();
        return Err(format!("Gemini API error: {}", txt));
    }

    let path_re = Regex::new(r#""path"\s*:\s*"([^"\\]+)""#).ok();
    let mut sse_buf = String::new();
    let mut raw_answer = String::new();
    let mut thoughts_accum = String::new();
    let mut emitted_drafting = false;
    let mut seen_paths: Vec<String> = Vec::new();
    let mut thought_end_ms: Option<u64> = None;

    loop {
        let chunk_opt = tokio::select! {
            _ = &mut cancel_rx => {
                return Err("CANCELLED".into());
            }
            c = res.chunk() => {
                c.map_err(|e| format!("Stream read error: {}", e))?
            }
        };

        let Some(chunk) = chunk_opt else {
            break;
        };

        sse_buf.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(newline_pos) = sse_buf.find('\n') {
            let line = sse_buf[..newline_pos].trim().to_string();
            sse_buf.drain(..=newline_pos);

            if !line.starts_with("data:") {
                continue;
            }
            let payload = line.trim_start_matches("data:").trim();
            if payload.is_empty() || payload == "[DONE]" {
                continue;
            }

            let Ok(json) = serde_json::from_str::<serde_json::Value>(payload) else {
                continue;
            };
            let Some(parts) = json["candidates"][0]["content"]["parts"].as_array() else {
                continue;
            };

            for part in parts {
                let text = part["text"].as_str().unwrap_or("");
                if text.is_empty() {
                    continue;
                }
                if part["thought"].as_bool() == Some(true) {
                    thoughts_accum.push_str(text);
                    let _ = app.emit(
                        "aetheris-agent-event",
                        serde_json::json!({
                            "type": "thought",
                            "delta": text
                        }),
                    );
                } else {
                    if !emitted_drafting {
                        emitted_drafting = true;
                        thought_end_ms = Some(started_at.elapsed().as_millis() as u64);
                        let _ = app.emit(
                            "aetheris-agent-event",
                            serde_json::json!({
                                "type": "activity",
                                "activity": {
                                    "id": "phase-think",
                                    "kind": "think",
                                    "label": if is_plan_mode { "Analyzed architecture & plan" } else { "Finished reasoning" },
                                    "status": "done"
                                }
                            }),
                        );
                        let _ = app.emit(
                            "aetheris-agent-event",
                            serde_json::json!({
                                "type": "activity",
                                "activity": {
                                    "id": "phase-draft",
                                    "kind": if is_plan_mode { "plan" } else { "edit" },
                                    "label": if is_plan_mode { "Writing step-by-step plan" } else { "Drafting workspace patches" },
                                    "status": "running"
                                }
                            }),
                        );
                    }

                    raw_answer.push_str(text);

                    if !is_plan_mode {
                        if let Some(ref re) = path_re {
                            for cap in re.captures_iter(&raw_answer) {
                                if let Some(m) = cap.get(1) {
                                    let p = m.as_str().to_string();
                                    if !seen_paths.contains(&p) {
                                        seen_paths.push(p.clone());
                                        let _ = app.emit(
                                            "aetheris-agent-event",
                                            serde_json::json!({
                                                "type": "activity",
                                                "activity": {
                                                    "id": format!("edit-{}", p),
                                                    "kind": "edit",
                                                    "label": format!("Preparing edit -> {}", p),
                                                    "filePath": p,
                                                    "status": "done"
                                                }
                                            }),
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    {
        let mut guard = state.tx.lock().await;
        *guard = None;
    }

    #[derive(Deserialize)]
    struct RawParsed {
        summary: Option<String>,
        steps: Option<Vec<String>>,
        patches: Option<Vec<AgentPatch>>,
    }

    let parsed = serde_json::from_str::<RawParsed>(raw_answer.trim())
        .map_err(|e| format!("Failed to parse structured agent plan: {}", e))?;

    let patches = if is_plan_mode {
        Vec::new()
    } else {
        parsed.patches.unwrap_or_default()
    };

    let _ = app.emit(
        "aetheris-agent-event",
        serde_json::json!({
            "type": "activity",
            "activity": {
                "id": "phase-draft",
                "kind": "done",
                "label": if is_plan_mode { "Plan ready".to_string() } else { format!("Prepared {} file change(s)", patches.len()) },
                "status": "done"
            }
        }),
    );

    Ok(AgentPlanResponse {
        summary: parsed.summary.unwrap_or_else(|| "Completed workspace analysis.".into()),
        steps: parsed.steps.unwrap_or_default(),
        patches,
        thoughts: thoughts_accum.trim().to_string(),
        thinking_duration_ms: thought_end_ms.unwrap_or_else(|| started_at.elapsed().as_millis() as u64),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AgentCancelState::default())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(target_os = "linux")]
            ensure_linux_desktop_integration();

            if let Some(window) = app.get_webview_window("main") {
                if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png")) {
                    let _ = window.set_icon(icon);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_workspace_tree,
            read_workspace_file,
            write_workspace_file,
            create_workspace_entry,
            rename_workspace_entry,
            delete_workspace_entry,
            search_workspace,
            exec_terminal_command,
            save_desktop_api_key,
            create_new_workspace_dir,
            chat_gemini,
            cancel_gemini_agent,
            run_gemini_agent
        ])
        .run(tauri::generate_context!())
        .expect("error while running Aetheris");
}
