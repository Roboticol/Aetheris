use ignore::WalkBuilder;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use tauri::Manager;

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
}

#[derive(Debug, Deserialize)]
struct LocalConfig {
    gemini_api_key: Option<String>,
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
async fn run_gemini_agent(
    prompt: String,
    active_file: Option<String>,
    files: Vec<AgentFileContext>,
    thinking_mode: String,
    agent_mode: Option<String>,
) -> Result<AgentPlanResponse, String> {
    let api_key = resolve_gemini_api_key()?;
    let client = reqwest::Client::new();

    let mut context_block = String::new();
    for f in files.iter().take(24) {
        context_block.push_str(&format!("\n--- FILE: {} ---\n{}\n", f.path, f.content));
    }

    let is_plan_mode = agent_mode.as_deref() == Some("plan");
    let thinking_level = if thinking_mode == "deep" { "HIGH" } else { "LOW" };
    let system_prompt = if is_plan_mode {
        "You are Aetheris in PLAN MODE (read-only). Analyze the workspace files and produce a structured engineering plan as JSON with: summary (technical findings and design overview), steps (detailed ordered implementation steps citing exact file paths and symbols), and patches (MUST be an empty array [] in Plan Mode—do not emit file modifications)."
    } else {
        "You are Aetheris in ACTION MODE. Inspect the provided workspace files and return JSON with summary, steps (array of strings), and patches (array of {path, action: create|modify|delete, rationale, content}). Always provide complete updated file content when action is create or modify."
    };

    let user_msg = format!(
        "Mode: {}\nActive file: {}\nUser request: {}\nWorkspace files:{}",
        if is_plan_mode { "PLAN" } else { "ACTION" },
        active_file.unwrap_or_else(|| "none".into()),
        prompt,
        context_block
    );

    let body = serde_json::json!({
        "systemInstruction": { "parts": [{ "text": system_prompt }] },
        "contents": [{ "role": "user", "parts": [{ "text": user_msg }] }],
        "generationConfig": {
            "responseMimeType": "application/json",
            "thinkingConfig": { "thinkingLevel": thinking_level }
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
    let raw_text = json["candidates"][0]["content"]["parts"]
        .as_array()
        .and_then(|parts| parts.iter().rev().find_map(|p| p["text"].as_str()))
        .ok_or_else(|| "Empty response from Gemini API".to_string())?;

    let mut parsed = serde_json::from_str::<AgentPlanResponse>(raw_text)
        .map_err(|e| format!("Failed to parse structured agent plan: {}", e))?;
    if is_plan_mode {
        parsed.patches.clear();
    }
    Ok(parsed)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
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
            run_gemini_agent
        ])
        .run(tauri::generate_context!())
        .expect("error while running Aetheris");
}
