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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileEntry {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitInfo {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    pub relative_time: String,
    pub pushed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusSnapshot {
    pub is_repo: bool,
    pub branch: String,
    pub branches: Vec<String>,
    pub remote_url: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub has_upstream: bool,
    pub staged: Vec<GitFileEntry>,
    pub changes: Vec<GitFileEntry>,
    pub unpushed_files: Vec<String>,
    pub pushed_files: Vec<String>,
    pub commits: Vec<GitCommitInfo>,
    pub user_name: Option<String>,
    pub user_email: Option<String>,
    pub gh_available: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffPreview {
    pub path: String,
    pub status: String,
    pub staged: bool,
    pub original_content: String,
    pub modified_content: String,
}

fn run_git_cmd(root: &Path, args: &[&str]) -> (i32, String, String) {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .output();

    match out {
        Ok(o) => (
            o.status.code().unwrap_or(1),
            String::from_utf8_lossy(&o.stdout).to_string(),
            String::from_utf8_lossy(&o.stderr).to_string(),
        ),
        Err(e) => (1, String::new(), e.to_string()),
    }
}

fn map_git_code(ch: char) -> &'static str {
    match ch {
        'A' => "A",
        'D' => "D",
        'R' => "R",
        'U' => "C",
        '?' => "U",
        _ => "M",
    }
}

fn collect_git_status(root: &Path) -> GitStatusSnapshot {
    let (code, inside_out, _) = run_git_cmd(root, &["rev-parse", "--is-inside-work-tree"]);
    let gh_available = Command::new("gh").arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
    let (_, u_name_raw, _) = run_git_cmd(root, &["config", "user.name"]);
    let (_, u_email_raw, _) = run_git_cmd(root, &["config", "user.email"]);
    let user_name = Some(u_name_raw.trim().to_string()).filter(|s| !s.is_empty());
    let user_email = Some(u_email_raw.trim().to_string()).filter(|s| !s.is_empty());

    if code != 0 || inside_out.trim() != "true" {
        return GitStatusSnapshot {
            is_repo: false,
            branch: String::new(),
            branches: Vec::new(),
            remote_url: None,
            ahead: 0,
            behind: 0,
            has_upstream: false,
            staged: Vec::new(),
            changes: Vec::new(),
            unpushed_files: Vec::new(),
            pushed_files: Vec::new(),
            commits: Vec::new(),
            user_name,
            user_email,
            gh_available,
        };
    }

    let (_, status_out, _) = run_git_cmd(root, &["status", "--porcelain=v1", "-b", "-uall"]);
    let mut branch = String::from("main");
    let mut staged: Vec<GitFileEntry> = Vec::new();
    let mut changes: Vec<GitFileEntry> = Vec::new();

    for line in status_out.lines() {
        if line.is_empty() {
            continue;
        }
        if let Some(header) = line.strip_prefix("## ") {
            let trimmed = header.trim();
            if let Some(rest) = trimmed.strip_prefix("No commits yet on ") {
                branch = rest.trim().to_string();
            } else if let Some((left, _)) = trimmed.split_once("...") {
                branch = left.trim().to_string();
            } else if let Some((left, _)) = trimmed.split_once(' ') {
                branch = left.trim().to_string();
            } else {
                branch = trimmed.to_string();
            }
            continue;
        }

        if line.len() < 4 {
            continue;
        }
        let mut chars = line.chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');
        let mut file_path = line[3..].trim().to_string();
        if let Some((_, right)) = file_path.split_once(" -> ") {
            file_path = right.trim().to_string();
        }
        if file_path.starts_with('"') && file_path.ends_with('"') && file_path.len() >= 2 {
            file_path = file_path[1..file_path.len() - 1].to_string();
        }

        if x == '?' && y == '?' {
            changes.push(GitFileEntry {
                path: file_path,
                status: "U".into(),
                staged: false,
            });
            continue;
        }

        if x != ' ' {
            staged.push(GitFileEntry {
                path: file_path.clone(),
                status: map_git_code(x).into(),
                staged: true,
            });
        }
        if y != ' ' {
            changes.push(GitFileEntry {
                path: file_path,
                status: map_git_code(y).into(),
                staged: false,
            });
        }
    }

    let (_, branch_out, _) = run_git_cmd(root, &["branch", "--format=%(refname:short)"]);
    let mut branches: Vec<String> = branch_out
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if !branch.is_empty() && !branches.contains(&branch) {
        branches.insert(0, branch.clone());
    }

    let (r_code, r_out, _) = run_git_cmd(root, &["remote", "get-url", "origin"]);
    let remote_url = if r_code == 0 {
        Some(r_out.trim().to_string()).filter(|s| !s.is_empty())
    } else {
        None
    };

    let (u_code, u_out, _) = run_git_cmd(root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    let mut upstream_ref = if u_code == 0 {
        u_out.trim().to_string()
    } else {
        String::new()
    };
    if upstream_ref.is_empty() && !branch.is_empty() && remote_url.is_some() {
        let candidate = format!("origin/{}", branch);
        let (oc, _, _) = run_git_cmd(root, &["rev-parse", "--verify", &candidate]);
        if oc == 0 {
            upstream_ref = candidate;
        }
    }

    let has_upstream = !upstream_ref.is_empty();
    let mut ahead: usize = 0;
    let mut behind: usize = 0;
    let mut unpushed_set = std::collections::HashSet::<String>::new();
    let mut unpushed_hashes = std::collections::HashSet::<String>::new();

    if has_upstream {
        let range_dots = format!("{}...HEAD", upstream_ref);
        let (cc, co, _) = run_git_cmd(root, &["rev-list", "--left-right", "--count", &range_dots]);
        if cc == 0 {
            let parts: Vec<&str> = co.trim().split_whitespace().collect();
            behind = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
            ahead = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        }

        let range_diff = format!("{}..HEAD", upstream_ref);
        let (dc, do_out, _) = run_git_cmd(root, &["diff", "--name-only", &range_diff]);
        if dc == 0 {
            for line in do_out.lines().map(|s| s.trim()).filter(|s| !s.is_empty()) {
                unpushed_set.insert(line.to_string());
            }
        }

        let (rc, ro_out, _) = run_git_cmd(root, &["rev-list", &range_diff]);
        if rc == 0 {
            for line in ro_out.lines().map(|s| s.trim()).filter(|s| !s.is_empty()) {
                unpushed_hashes.insert(line.to_string());
            }
        }
    }

    let (tc, tracked_out, _) = run_git_cmd(root, &["ls-files"]);
    let tracked_files: Vec<String> = if tc == 0 {
        tracked_out
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    } else {
        Vec::new()
    };

    let mut dirty_set = std::collections::HashSet::<String>::new();
    for s in &staged {
        dirty_set.insert(s.path.clone());
    }
    for c in &changes {
        dirty_set.insert(c.path.clone());
    }

    if !has_upstream {
        for f in &tracked_files {
            if !dirty_set.contains(f) {
                unpushed_set.insert(f.clone());
            }
        }
    }

    let pushed_files: Vec<String> = if has_upstream {
        tracked_files
            .into_iter()
            .filter(|f| !dirty_set.contains(f) && !unpushed_set.contains(f))
            .collect()
    } else {
        Vec::new()
    };

    let (lc, log_out, _) = run_git_cmd(
        root,
        &["log", "-n", "15", "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ar"],
    );
    let commits: Vec<GitCommitInfo> = if lc == 0 {
        log_out
            .lines()
            .filter(|l| !l.is_empty())
            .map(|row| {
                let cols: Vec<&str> = row.split('\x1f').collect();
                let hash = cols.first().copied().unwrap_or("").to_string();
                let short_hash = cols.get(1).copied().unwrap_or("").to_string();
                let message = cols.get(2).copied().unwrap_or("").to_string();
                let author = cols.get(3).copied().unwrap_or("").to_string();
                let relative_time = cols.get(4).copied().unwrap_or("").to_string();
                let pushed = has_upstream && !unpushed_hashes.contains(&hash);
                GitCommitInfo {
                    hash,
                    short_hash,
                    message,
                    author,
                    relative_time,
                    pushed,
                }
            })
            .collect()
    } else {
        Vec::new()
    };

    if !has_upstream && !commits.is_empty() {
        ahead = commits.len();
    }

    GitStatusSnapshot {
        is_repo: true,
        branch,
        branches,
        remote_url,
        ahead,
        behind,
        has_upstream,
        staged,
        changes,
        unpushed_files: unpushed_set.into_iter().collect(),
        pushed_files,
        commits,
        user_name,
        user_email,
        gh_available,
    }
}

#[tauri::command]
async fn git_status(root: String) -> Result<GitStatusSnapshot, String> {
    let root_path = PathBuf::from(&root);
    tokio::task::spawn_blocking(move || collect_git_status(&root_path))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn git_diff_file(
    root: String,
    rel_path: String,
    staged: bool,
    status: String,
) -> Result<GitDiffPreview, String> {
    let root_path = PathBuf::from(&root);
    let target = sanitize_relative_path(&root_path, &rel_path)?;
    tokio::task::spawn_blocking(move || {
        let mut original_content = String::new();
        let mut modified_content = String::new();

        if staged {
            let head_spec = format!("HEAD:{}", rel_path);
            let (hc, ho, _) = run_git_cmd(&root_path, &["show", &head_spec]);
            if hc == 0 {
                original_content = ho;
            }
            if status != "D" {
                let idx_spec = format!(":{}", rel_path);
                let (ic, io, _) = run_git_cmd(&root_path, &["show", &idx_spec]);
                if ic == 0 {
                    modified_content = io;
                }
            }
        } else {
            if status != "U" {
                let idx_spec = format!(":{}", rel_path);
                let (ic, io, _) = run_git_cmd(&root_path, &["show", &idx_spec]);
                if ic == 0 {
                    original_content = io;
                } else {
                    let head_spec = format!("HEAD:{}", rel_path);
                    let (hc, ho, _) = run_git_cmd(&root_path, &["show", &head_spec]);
                    if hc == 0 {
                        original_content = ho;
                    }
                }
            }
            if status != "D" {
                modified_content = fs::read_to_string(&target).unwrap_or_default();
            }
        }

        GitDiffPreview {
            path: rel_path,
            status,
            staged,
            original_content,
            modified_content,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn git_init_repo(root: String) -> Result<GitStatusSnapshot, String> {
    let root_path = PathBuf::from(&root);
    tokio::task::spawn_blocking(move || {
        let (c1, _, _) = run_git_cmd(&root_path, &["init", "-b", "main"]);
        if c1 != 0 {
            let (c2, _, err2) = run_git_cmd(&root_path, &["init"]);
            if c2 != 0 {
                return Err(err2);
            }
        }
        Ok(collect_git_status(&root_path))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_stage(root: String, paths: Vec<String>, all: bool) -> Result<GitStatusSnapshot, String> {
    let root_path = PathBuf::from(&root);
    tokio::task::spawn_blocking(move || {
        let mut args: Vec<&str> = vec!["add"];
        if all {
            args.push("-A");
        } else {
            args.push("--");
            for p in &paths {
                args.push(p.as_str());
            }
        }
        let (code, _, err) = run_git_cmd(&root_path, &args);
        if code != 0 {
            return Err(err);
        }
        Ok(collect_git_status(&root_path))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_unstage(root: String, paths: Vec<String>, all: bool) -> Result<GitStatusSnapshot, String> {
    let root_path = PathBuf::from(&root);
    tokio::task::spawn_blocking(move || {
        let (has_head, _, _) = run_git_cmd(&root_path, &["rev-parse", "--verify", "HEAD"]);
        let mut args: Vec<&str> = if has_head == 0 {
            if all {
                vec!["reset", "HEAD"]
            } else {
                let mut v = vec!["reset", "HEAD", "--"];
                for p in &paths {
                    v.push(p.as_str());
                }
                v
            }
        } else if all {
            vec!["rm", "-r", "--cached", "."]
        } else {
            let mut v = vec!["rm", "--cached", "--"];
            for p in &paths {
                v.push(p.as_str());
            }
            v
        };
        let (code, _, err) = run_git_cmd(&root_path, &args);
        let _ = args.len();
        if code != 0 {
            return Err(err);
        }
        Ok(collect_git_status(&root_path))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_discard(root: String, rel_path: String, untracked: bool) -> Result<GitStatusSnapshot, String> {
    let root_path = PathBuf::from(&root);
    let target = sanitize_relative_path(&root_path, &rel_path)?;
    tokio::task::spawn_blocking(move || {
        if untracked {
            if target.is_dir() {
                fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
            } else if target.exists() {
                fs::remove_file(&target).map_err(|e| e.to_string())?;
            }
        } else {
            let (code, _, err) = run_git_cmd(&root_path, &["checkout", "--", &rel_path]);
            if code != 0 {
                return Err(err);
            }
        }
        Ok(collect_git_status(&root_path))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_commit(
    root: String,
    message: String,
    stage_all_if_empty: bool,
    user_name: Option<String>,
    user_email: Option<String>,
) -> Result<GitStatusSnapshot, String> {
    let root_path = PathBuf::from(&root);
    tokio::task::spawn_blocking(move || {
        let trimmed = message.trim();
        if trimmed.is_empty() {
            return Err("Commit message is required.".into());
        }
        if let Some(ref name) = user_name {
            if !name.trim().is_empty() {
                run_git_cmd(&root_path, &["config", "user.name", name.trim()]);
            }
        }
        if let Some(ref email) = user_email {
            if !email.trim().is_empty() {
                run_git_cmd(&root_path, &["config", "user.email", email.trim()]);
            }
        }
        let snap = collect_git_status(&root_path);
        if snap.staged.is_empty() && stage_all_if_empty {
            run_git_cmd(&root_path, &["add", "-A"]);
        }
        let (code, out, err) = run_git_cmd(&root_path, &["commit", "-m", trimmed]);
        if code != 0 {
            return Err(if err.trim().is_empty() { out } else { err });
        }
        Ok(collect_git_status(&root_path))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_branch(root: String, action: String, name: String) -> Result<GitStatusSnapshot, String> {
    let root_path = PathBuf::from(&root);
    tokio::task::spawn_blocking(move || {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Branch name is required.".into());
        }
        let args = if action == "create" {
            vec!["checkout", "-b", trimmed]
        } else {
            vec!["checkout", trimmed]
        };
        let (code, _, err) = run_git_cmd(&root_path, &args);
        if code != 0 {
            return Err(err);
        }
        Ok(collect_git_status(&root_path))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_set_remote(root: String, url: String) -> Result<GitStatusSnapshot, String> {
    let root_path = PathBuf::from(&root);
    tokio::task::spawn_blocking(move || {
        let trimmed = url.trim();
        if trimmed.is_empty() {
            return Err("Remote URL is required.".into());
        }
        let (exists, _, _) = run_git_cmd(&root_path, &["remote", "get-url", "origin"]);
        let args = if exists == 0 {
            vec!["remote", "set-url", "origin", trimmed]
        } else {
            vec!["remote", "add", "origin", trimmed]
        };
        let (code, _, err) = run_git_cmd(&root_path, &args);
        if code != 0 {
            return Err(err);
        }
        Ok(collect_git_status(&root_path))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_sync(root: String, action: String) -> Result<GitStatusSnapshot, String> {
    let root_path = PathBuf::from(&root);
    tokio::task::spawn_blocking(move || {
        let snap = collect_git_status(&root_path);
        if snap.remote_url.is_none() {
            return Err("No GitHub remote \"origin\" configured yet.".into());
        }
        let branch = if snap.branch.is_empty() { "main".to_string() } else { snap.branch.clone() };
        match action.as_str() {
            "fetch" => {
                let (c, _, e) = run_git_cmd(&root_path, &["fetch", "--all", "--prune"]);
                if c != 0 {
                    return Err(e);
                }
            }
            "pull" => {
                let (c, _, e) = run_git_cmd(&root_path, &["pull", "--rebase"]);
                if c != 0 {
                    return Err(e);
                }
            }
            "push" => {
                let args: Vec<&str> = if snap.has_upstream {
                    vec!["push"]
                } else {
                    vec!["push", "-u", "origin", branch.as_str()]
                };
                let (c, _, e) = run_git_cmd(&root_path, &args);
                if c != 0 {
                    return Err(e);
                }
            }
            _ => {
                if snap.has_upstream {
                    let (pc, _, pe) = run_git_cmd(&root_path, &["pull", "--rebase"]);
                    if pc != 0 {
                        return Err(pe);
                    }
                }
                let args: Vec<&str> = if snap.has_upstream {
                    vec!["push"]
                } else {
                    vec!["push", "-u", "origin", branch.as_str()]
                };
                let (c, _, e) = run_git_cmd(&root_path, &args);
                if c != 0 {
                    return Err(e);
                }
            }
        }
        Ok(collect_git_status(&root_path))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_generate_commit_message(root: String) -> Result<String, String> {
    let root_path = PathBuf::from(&root);
    let diff_text = tokio::task::spawn_blocking(move || {
        let (_, staged, _) = run_git_cmd(&root_path, &["diff", "--cached"]);
        let working = if staged.trim().is_empty() {
            run_git_cmd(&root_path, &["diff"]).1
        } else {
            staged
        };
        let status_short = run_git_cmd(&root_path, &["status", "--short"]).1;
        let combined = if working.trim().is_empty() { status_short } else { working };
        combined.chars().take(12000).collect::<String>()
    })
    .await
    .map_err(|e| e.to_string())?;

    if diff_text.trim().is_empty() {
        return Err("No changes to summarize.".into());
    }

    let api_key = resolve_gemini_api_key()?;
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "contents": [{
            "role": "user",
            "parts": [{
                "text": format!("Write a single concise conventional git commit message (<= 72 chars on first line, no quotes or markdown) for these changes:\n\n{}", diff_text)
            }]
        }],
        "generationConfig": {
            "thinkingConfig": { "thinkingLevel": "LOW" }
        }
    });
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent?key={}",
        api_key
    );
    let res = client.post(&url).json(&body).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(res.text().await.unwrap_or_else(|_| "Gemini request failed".into()));
    }
    let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let msg = json["candidates"][0]["content"]["parts"]
        .as_array()
        .and_then(|parts| parts.iter().rev().find_map(|p| p["text"].as_str()))
        .unwrap_or("")
        .trim()
        .trim_matches(|c| c == '"' || c == '\'' || c == '`')
        .to_string();
    Ok(msg)
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
            run_gemini_agent,
            git_status,
            git_diff_file,
            git_init_repo,
            git_stage,
            git_unstage,
            git_discard,
            git_commit,
            git_branch,
            git_set_remote,
            git_sync,
            git_generate_commit_message
        ])
        .run(tauri::generate_context!())
        .expect("error while running Aetheris");
}
