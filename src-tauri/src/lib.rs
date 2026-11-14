use ignore::WalkBuilder;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
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
    pub cwd: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentPatch {
    pub path: String,
    pub action: String,
    pub rationale: String,
    pub content: String,
    pub original_content: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GroundingSource {
    pub title: String,
    pub uri: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPlanResponse {
    pub summary: String,
    pub steps: Vec<String>,
    pub patches: Vec<AgentPatch>,
    pub thoughts: String,
    pub thinking_duration_ms: u64,
    pub sources: Vec<GroundingSource>,
    pub search_queries: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreatedProjectSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub language: String,
    pub root_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickChatResponse {
    pub reply: String,
    pub created_projects: Vec<CreatedProjectSummary>,
    pub sources: Vec<GroundingSource>,
    pub search_queries: Vec<String>,
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
async fn exec_terminal_command(
    root: String,
    command: String,
    cwd: Option<String>,
) -> Result<TerminalOutput, String> {
    let root_path = PathBuf::from(&root);
    let root_canonical = fs::canonicalize(&root_path).unwrap_or_else(|_| root_path.clone());

    let start_dir = match cwd.as_deref().map(str::trim).filter(|s| !s.is_empty() && *s != ".") {
        Some(c) => {
            let candidate = {
                let p = PathBuf::from(c);
                if p.is_absolute() {
                    p
                } else {
                    root_canonical.join(p)
                }
            };
            if candidate.is_dir() {
                fs::canonicalize(&candidate).unwrap_or(candidate)
            } else {
                root_canonical.clone()
            }
        }
        None => root_canonical.clone(),
    };

    let cmd_clone = command.clone();
    let start_dir_clone = start_dir.clone();
    let output = tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        let out = {
            let wrapped = format!(
                "{} & set __AETHERIS_EC=%errorlevel% & echo __AETHERIS_CWD__:%CD% & exit /b %__AETHERIS_EC%",
                cmd_clone
            );
            Command::new("cmd")
                .args(["/C", &wrapped])
                .current_dir(&start_dir_clone)
                .output()
        };

        #[cfg(not(target_os = "windows"))]
        let out = {
            let wrapped = "eval \"$AETHERIS_CMD\"\n__aetheris_ec=$?\nprintf '\\n__AETHERIS_CWD__:%s\\n' \"$(pwd -P)\"\nexit $__aetheris_ec";
            Command::new("sh")
                .args(["-c", wrapped])
                .env("AETHERIS_CMD", &cmd_clone)
                .env("TERM", "dumb")
                .current_dir(&start_dir_clone)
                .output()
        };

        out
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let mut stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let marker_re = Regex::new(r"(?m)\r?\n?__AETHERIS_CWD__:([^\r\n]+)\r?\n?\z").ok();

    let mut next_cwd = if let Ok(rel) = start_dir.strip_prefix(&root_canonical) {
        let s = rel.to_string_lossy().replace('\\', "/");
        if s.is_empty() { ".".to_string() } else { s }
    } else {
        start_dir.to_string_lossy().replace('\\', "/")
    };

    if let Some(re) = marker_re {
        if let Some(caps) = re.captures(&stdout) {
            if let (Some(full_m), Some(path_m)) = (caps.get(0), caps.get(1)) {
                let captured = path_m.as_str().trim().to_string();
                let cut_at = full_m.start();
                stdout.truncate(cut_at);
                if !captured.is_empty() {
                    let cap_path = PathBuf::from(&captured);
                    let cap_canon = fs::canonicalize(&cap_path).unwrap_or(cap_path);
                    next_cwd = if let Ok(rel) = cap_canon.strip_prefix(&root_canonical) {
                        let s = rel.to_string_lossy().replace('\\', "/");
                        if s.is_empty() { ".".to_string() } else { s }
                    } else {
                        cap_canon.to_string_lossy().replace('\\', "/")
                    };
                }
            }
        }
    }

    Ok(TerminalOutput {
        stdout,
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(1),
        cwd: next_cwd,
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

fn sanitize_project_slug(raw: &str) -> Result<String, String> {
    let mut slug = String::new();
    let mut prev_dash = false;
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            slug.push(ch);
            prev_dash = false;
        } else if !prev_dash && !slug.is_empty() {
            slug.push('-');
            prev_dash = true;
        }
    }
    let trimmed = slug.trim_matches('-').to_string();
    if trimmed.is_empty() {
        return Err("Project name must contain letters or numbers.".into());
    }
    Ok(trimmed)
}

fn quick_chat_projects_root() -> PathBuf {
    dirs::home_dir()
        .or_else(dirs::document_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("AetherisProjects")
}

fn write_new_file_only(target: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    match OpenOptions::new().write(true).create_new(true).open(target) {
        Ok(mut file) => file.write_all(content.as_bytes()).map_err(|e| e.to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => Err(format!(
            "Permission denied: \"{}\" already exists. Quick Chat has create-only permissions and cannot edit existing files.",
            target.file_name().and_then(|n| n.to_str()).unwrap_or("file")
        )),
        Err(err) => Err(err.to_string()),
    }
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
async fn chat_gemini(messages: Vec<ChatTurnInput>) -> Result<QuickChatResponse, String> {
    let api_key = resolve_gemini_api_key()?;
    let client = reqwest::Client::new();

    let mut contents: Vec<serde_json::Value> = messages
        .into_iter()
        .filter(|m| !m.content.trim().is_empty())
        .rev()
        .take(16)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|m| {
            let role = if m.role == "assistant" { "model" } else { "user" };
            serde_json::json!({
                "role": role,
                "parts": [{ "text": m.content }]
            })
        })
        .collect();

    if contents.is_empty() {
        return Err("Message cannot be empty.".into());
    }

    let tools = serde_json::json!([
        { "googleSearch": {} },
        {
            "functionDeclarations": [
                {
                    "name": "create_project",
                    "description": "Create a brand-new project workspace under ~/AetherisProjects with folders and starter files. Automatically registers it on the Home screen project list. Create-only: never overwrites existing files.",
                    "parameters": {
                        "type": "OBJECT",
                        "properties": {
                            "project_name": { "type": "STRING", "description": "Slug folder name (letters, numbers, hyphens, underscores)." },
                            "description": { "type": "STRING", "description": "Short 1-line project summary." },
                            "language": { "type": "STRING", "description": "Primary language (e.g. Rust, TypeScript, Python)." },
                            "folders": {
                                "type": "ARRAY",
                                "items": { "type": "STRING" },
                                "description": "Optional relative folder paths inside the project."
                            },
                            "files": {
                                "type": "ARRAY",
                                "description": "Starter files to create inside the project.",
                                "items": {
                                    "type": "OBJECT",
                                    "properties": {
                                        "path": { "type": "STRING", "description": "Relative path inside project." },
                                        "content": { "type": "STRING", "description": "Initial file content." }
                                    },
                                    "required": ["path", "content"]
                                }
                            }
                        },
                        "required": ["project_name", "description", "language", "files"]
                    }
                },
                {
                    "name": "create_folder",
                    "description": "Create a new folder inside a project workspace (creates the project if new). Does not modify or delete existing files.",
                    "parameters": {
                        "type": "OBJECT",
                        "properties": {
                            "project_name": { "type": "STRING", "description": "Project directory slug." },
                            "folder_path": { "type": "STRING", "description": "Relative folder path inside project." }
                        },
                        "required": ["project_name", "folder_path"]
                    }
                },
                {
                    "name": "create_file",
                    "description": "Create a NEW file inside a project workspace. Strictly create-only: fails if the file already exists.",
                    "parameters": {
                        "type": "OBJECT",
                        "properties": {
                            "project_name": { "type": "STRING", "description": "Project directory slug." },
                            "file_path": { "type": "STRING", "description": "Relative file path inside project." },
                            "content": { "type": "STRING", "description": "Initial content for the new file." }
                        },
                        "required": ["project_name", "file_path", "content"]
                    }
                }
            ]
        }
    ]);

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent?key={}",
        api_key
    );

    let base_root = quick_chat_projects_root();
    let mut created_map: HashMap<String, CreatedProjectSummary> = HashMap::new();
    let mut created_order: Vec<String> = Vec::new();
    let mut reply_text = String::new();
    let mut sources_map: HashMap<String, GroundingSource> = HashMap::new();
    let mut sources_order: Vec<String> = Vec::new();
    let mut search_queries: Vec<String> = Vec::new();

    for _turn in 0..8 {
        let body = serde_json::json!({
            "systemInstruction": {
                "parts": [{
                    "text": "You are Aetheris Quick Chat on the Home Screen. You help users brainstorm, look up current technical information via Google Search, or start new projects. PERMISSIONS: You have CREATE-ONLY workspace permissions via create_project, create_folder, and create_file. You MUST NEVER edit, overwrite, or delete existing files (if the user asks to modify an existing file or project, explain that Quick Chat is create-only and they should open the project in the IDE editor to edit files). Whenever the user asks to create a new project, call create_project (or create_folder/create_file) immediately—the created project is automatically added to the Home screen list. Use Google Search grounding whenever up-to-date web facts, documentation, or current information are needed."
                }]
            },
            "contents": contents,
            "tools": tools,
            "toolConfig": { "includeServerSideToolInvocations": true },
            "generationConfig": {
                "thinkingConfig": { "thinkingLevel": "LOW" }
            }
        });

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
        if let Some(queries) = json["candidates"][0]["groundingMetadata"]["webSearchQueries"].as_array() {
            for q in queries {
                if let Some(qs) = q.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    if !search_queries.iter().any(|existing| existing == qs) {
                        search_queries.push(qs.to_string());
                    }
                }
            }
        }
        if let Some(chunks) = json["candidates"][0]["groundingMetadata"]["groundingChunks"].as_array() {
            for chunk in chunks {
                if let Some(uri) = chunk["web"]["uri"].as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    let title = chunk["web"]["title"]
                        .as_str()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(uri)
                        .to_string();
                    if !sources_map.contains_key(uri) {
                        sources_order.push(uri.to_string());
                        sources_map.insert(uri.to_string(), GroundingSource { title, uri: uri.to_string() });
                    }
                }
            }
        }

        let candidate_content = json["candidates"][0]["content"].clone();
        let parts = candidate_content["parts"].as_array().cloned().unwrap_or_default();

        if !candidate_content.is_null() {
            contents.push(candidate_content);
        }

        let mut function_calls: Vec<serde_json::Value> = Vec::new();
        let mut text_parts: Vec<String> = Vec::new();

        for part in &parts {
            if part.get("functionCall").is_some() {
                function_calls.push(part["functionCall"].clone());
            } else if part["thought"].as_bool() != Some(true) {
                if let Some(t) = part["text"].as_str() {
                    if !t.is_empty() {
                        text_parts.push(t.to_string());
                    }
                }
            }
        }

        if function_calls.is_empty() {
            reply_text = text_parts.join("").trim().to_string();
            break;
        }

        let mut resp_parts: Vec<serde_json::Value> = Vec::new();
        for fc in function_calls {
            let fc_name = fc["name"].as_str().unwrap_or("");
            let fc_args = &fc["args"];
            let tool_result: serde_json::Value = match fc_name {
                "create_project" => {
                    let raw_name = fc_args["project_name"].as_str().unwrap_or("");
                    match sanitize_project_slug(raw_name) {
                        Err(e) => serde_json::json!({ "error": e }),
                        Ok(slug) => {
                            let proj_dir = base_root.join(&slug);
                            if proj_dir.exists() {
                                serde_json::json!({
                                    "error": format!("Project \"{}\" already exists. Quick Chat only creates new projects/files and cannot overwrite existing projects.", slug)
                                })
                            } else if let Err(e) = fs::create_dir_all(&proj_dir) {
                                serde_json::json!({ "error": e.to_string() })
                            } else {
                                let desc = fc_args["description"]
                                    .as_str()
                                    .unwrap_or("Project created via Quick Chat")
                                    .chars()
                                    .take(120)
                                    .collect::<String>();
                                let lang = fc_args["language"]
                                    .as_str()
                                    .unwrap_or("Folder")
                                    .chars()
                                    .take(40)
                                    .collect::<String>();

                                if let Some(folders) = fc_args["folders"].as_array() {
                                    for folder in folders {
                                        if let Some(f_str) = folder.as_str() {
                                            if let Ok(target) = sanitize_relative_path(&proj_dir, f_str.trim_start_matches('/')) {
                                                let _ = fs::create_dir_all(target);
                                            }
                                        }
                                    }
                                }

                                let mut created_files: Vec<String> = Vec::new();
                                let mut create_err: Option<String> = None;
                                if let Some(files) = fc_args["files"].as_array() {
                                    for f in files {
                                        let rel = f["path"].as_str().unwrap_or("").trim_start_matches('/');
                                        if rel.is_empty() {
                                            continue;
                                        }
                                        let content = f["content"].as_str().unwrap_or("");
                                        match sanitize_relative_path(&proj_dir, rel) {
                                            Ok(target) => {
                                                if let Err(e) = write_new_file_only(&target, content) {
                                                    create_err = Some(e);
                                                    break;
                                                }
                                                created_files.push(rel.to_string());
                                            }
                                            Err(e) => {
                                                create_err = Some(e);
                                                break;
                                            }
                                        }
                                    }
                                }

                                if let Some(err) = create_err {
                                    serde_json::json!({ "error": err })
                                } else {
                                    if created_files.is_empty() {
                                        let readme = proj_dir.join("README.md");
                                        let _ = write_new_file_only(&readme, &format!("# {}\n\n{}\n", slug, desc));
                                        created_files.push("README.md".into());
                                    }
                                    let root_str = proj_dir.to_string_lossy().to_string();
                                    if !created_map.contains_key(&slug) {
                                        created_order.push(slug.clone());
                                    }
                                    created_map.insert(
                                        slug.clone(),
                                        CreatedProjectSummary {
                                            id: root_str.clone(),
                                            name: slug.clone(),
                                            description: desc,
                                            language: lang,
                                            root_path: Some(root_str.clone()),
                                        },
                                    );
                                    serde_json::json!({
                                        "ok": true,
                                        "project": slug,
                                        "rootPath": root_str,
                                        "createdFiles": created_files
                                    })
                                }
                            }
                        }
                    }
                }
                "create_folder" => {
                    let raw_name = fc_args["project_name"].as_str().unwrap_or("");
                    let folder_path = fc_args["folder_path"].as_str().unwrap_or("").trim_start_matches('/');
                    match sanitize_project_slug(raw_name) {
                        Err(e) => serde_json::json!({ "error": e }),
                        Ok(slug) => {
                            let proj_dir = base_root.join(&slug);
                            match fs::create_dir_all(&proj_dir).and_then(|_| {
                                let target = sanitize_relative_path(&proj_dir, folder_path)
                                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
                                fs::create_dir_all(target)
                            }) {
                                Err(e) => serde_json::json!({ "error": e.to_string() }),
                                Ok(()) => {
                                    let root_str = proj_dir.to_string_lossy().to_string();
                                    if !created_map.contains_key(&slug) {
                                        created_order.push(slug.clone());
                                        created_map.insert(
                                            slug.clone(),
                                            CreatedProjectSummary {
                                                id: root_str.clone(),
                                                name: slug.clone(),
                                                description: "Project created via Quick Chat".into(),
                                                language: "Folder".into(),
                                                root_path: Some(root_str),
                                            },
                                        );
                                    }
                                    serde_json::json!({ "ok": true, "project": slug, "folder": folder_path })
                                }
                            }
                        }
                    }
                }
                "create_file" => {
                    let raw_name = fc_args["project_name"].as_str().unwrap_or("");
                    let rel = fc_args["file_path"].as_str().unwrap_or("").trim_start_matches('/');
                    let content = fc_args["content"].as_str().unwrap_or("");
                    match sanitize_project_slug(raw_name) {
                        Err(e) => serde_json::json!({ "error": e }),
                        Ok(slug) => {
                            let proj_dir = base_root.join(&slug);
                            if let Err(e) = fs::create_dir_all(&proj_dir) {
                                serde_json::json!({ "error": e.to_string() })
                            } else {
                                match sanitize_relative_path(&proj_dir, rel)
                                    .and_then(|target| write_new_file_only(&target, content))
                                {
                                    Err(e) => serde_json::json!({ "error": e }),
                                    Ok(()) => {
                                        let root_str = proj_dir.to_string_lossy().to_string();
                                        if !created_map.contains_key(&slug) {
                                            created_order.push(slug.clone());
                                            created_map.insert(
                                                slug.clone(),
                                                CreatedProjectSummary {
                                                    id: root_str.clone(),
                                                    name: slug.clone(),
                                                    description: "Project created via Quick Chat".into(),
                                                    language: "Folder".into(),
                                                    root_path: Some(root_str),
                                                },
                                            );
                                        }
                                        serde_json::json!({ "ok": true, "project": slug, "file": rel })
                                    }
                                }
                            }
                        }
                    }
                }
                other => serde_json::json!({ "error": format!("Unknown tool: {}", other) }),
            };

            let mut fr = serde_json::json!({
                "name": fc_name,
                "response": tool_result
            });
            if let Some(id_val) = fc["id"].as_str() {
                fr["id"] = serde_json::Value::String(id_val.to_string());
            }
            resp_parts.push(serde_json::json!({ "functionResponse": fr }));
        }

        contents.push(serde_json::json!({
            "role": "user",
            "parts": resp_parts
        }));
    }

    let created_projects = created_order
        .into_iter()
        .filter_map(|slug| created_map.remove(&slug))
        .collect();

    let sources = sources_order
        .into_iter()
        .filter_map(|u| sources_map.remove(&u))
        .collect();

    Ok(QuickChatResponse {
        reply: if reply_text.is_empty() { "Done.".into() } else { reply_text },
        created_projects,
        sources,
        search_queries,
    })
}

#[tauri::command]
async fn cancel_gemini_agent(state: tauri::State<'_, AgentCancelState>) -> Result<(), String> {
    let mut guard = state.tx.lock().await;
    if let Some(tx) = guard.take() {
        let _ = tx.send(());
    }
    Ok(())
}

fn collect_workspace_rel_paths(
    root_path: &Path,
    open_buffers: &HashMap<String, String>,
) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut paths: Vec<String> = Vec::new();

    let walker = WalkBuilder::new(root_path)
        .hidden(false)
        .git_ignore(true)
        .build();

    for entry in walker.flatten() {
        if paths.len() >= 1000 {
            break;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let rel = path
            .strip_prefix(root_path)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        if rel.is_empty()
            || rel.starts_with(".git/")
            || rel == ".git"
            || rel.starts_with("node_modules/")
            || rel.starts_with("target/")
            || rel.starts_with("dist/")
            || rel == ".aetheris-project.json"
        {
            continue;
        }
        if seen.insert(rel.clone()) {
            paths.push(rel);
        }
    }

    for k in open_buffers.keys() {
        if seen.insert(k.clone()) {
            paths.push(k.clone());
        }
    }

    paths.sort();
    paths
}

fn read_workspace_raw_text(
    root_path: &Path,
    open_buffers: &HashMap<String, String>,
    rel_path: &str,
) -> Option<String> {
    if let Some(buf) = open_buffers.get(rel_path) {
        return Some(buf.clone());
    }
    let target = sanitize_relative_path(root_path, rel_path).ok()?;
    fs::read_to_string(target).ok()
}

fn emit_agent_activity(
    app: &tauri::AppHandle,
    id: &str,
    kind: &str,
    label: &str,
    file_path: Option<&str>,
    status: &str,
) {
    let mut act = serde_json::json!({
        "id": id,
        "kind": kind,
        "label": label,
        "status": status
    });
    if let Some(fp) = file_path {
        act["filePath"] = serde_json::Value::String(fp.to_string());
    }
    let _ = app.emit(
        "aetheris-agent-event",
        serde_json::json!({
            "type": "activity",
            "activity": act
        }),
    );
}

#[tauri::command]
async fn run_gemini_agent(
    app: tauri::AppHandle,
    state: tauri::State<'_, AgentCancelState>,
    root: String,
    prompt: String,
    active_file: Option<String>,
    open_buffers: Option<HashMap<String, String>>,
    effort: Option<String>,
    agent_mode: Option<String>,
    autopilot: Option<bool>,
    history: Option<Vec<ChatTurnInput>>,
) -> Result<AgentPlanResponse, String> {
    let api_key = resolve_gemini_api_key()?;
    let client = reqwest::Client::new();
    let started_at = Instant::now();
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err("Workspace directory does not exist".into());
    }

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
    let max_turns: usize = match effort.as_deref() {
        Some("xhigh") => 24,
        Some("high") => 18,
        Some("low") => 8,
        _ => 14,
    };

    let buffer_map = open_buffers.unwrap_or_default();
    let all_paths = collect_workspace_rel_paths(&root_path, &buffer_map);
    let preview_tree_list = all_paths
        .iter()
        .take(120)
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
    let active_preview = active_file
        .as_deref()
        .and_then(|af| read_workspace_raw_text(&root_path, &buffer_map, af));

    emit_agent_activity(
        &app,
        "phase-think",
        "think",
        if is_plan_mode {
            "Analyzing architecture & plan"
        } else {
            "Inspecting workspace with tools"
        },
        None,
        "running",
    );

    let list_decl = serde_json::json!({
        "name": "list_workspace_files",
        "description": "List all files in the workspace. Use optional directory prefix or substring filter to inspect large repositories.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "directory": { "type": "STRING", "description": "Optional relative directory prefix (e.g. \"src\" or \"src-tauri\")." },
                "filter": { "type": "STRING", "description": "Optional case-insensitive path substring filter." }
            }
        }
    });
    let read_decl = serde_json::json!({
        "name": "read_file",
        "description": "Read complete or line-ranged contents of any workspace file with line numbers. Read large files in slices (e.g. 1..400, 401..800) so nothing is missed.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "path": { "type": "STRING", "description": "Relative file path inside workspace." },
                "start_line": { "type": "INTEGER", "description": "1-based start line (default 1)." },
                "end_line": { "type": "INTEGER", "description": "1-based inclusive end line (default up to start_line + 449)." }
            },
            "required": ["path"]
        }
    });
    let search_decl = serde_json::json!({
        "name": "search_workspace",
        "description": "Search across all workspace files for a text string or symbol name. Returns matching file paths, line numbers, and line previews.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "query": { "type": "STRING", "description": "Text or symbol substring to search for." },
                "case_sensitive": { "type": "BOOLEAN", "description": "Match exact case if true." }
            },
            "required": ["query"]
        }
    });
    let edit_decl = serde_json::json!({
        "name": "propose_edit",
        "description": "Propose targeted search-and-replace hunks on an existing file without rewriting unrelated parts of the file. Always read the relevant lines first so old_text matches verbatim.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "path": { "type": "STRING", "description": "Relative path of existing file to modify." },
                "rationale": { "type": "STRING", "description": "Concise reason for this edit." },
                "edits": {
                    "type": "ARRAY",
                    "description": "Ordered list of exact search-and-replace hunks.",
                    "items": {
                        "type": "OBJECT",
                        "properties": {
                            "old_text": { "type": "STRING", "description": "Exact existing lines in the file to replace (must match uniquely)." },
                            "new_text": { "type": "STRING", "description": "Replacement code for old_text." }
                        },
                        "required": ["old_text", "new_text"]
                    }
                }
            },
            "required": ["path", "rationale", "edits"]
        }
    });
    let create_decl = serde_json::json!({
        "name": "propose_create_file",
        "description": "Stage creation of a brand new file in the workspace for diff review.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "path": { "type": "STRING", "description": "Relative path for the new file." },
                "rationale": { "type": "STRING", "description": "Why this file is being created." },
                "content": { "type": "STRING", "description": "Complete contents of the new file." }
            },
            "required": ["path", "rationale", "content"]
        }
    });
    let delete_decl = serde_json::json!({
        "name": "propose_delete_file",
        "description": "Stage deletion of a workspace file for review.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "path": { "type": "STRING", "description": "Relative path of file to delete." },
                "rationale": { "type": "STRING", "description": "Why this file should be removed." }
            },
            "required": ["path", "rationale"]
        }
    });

    let declarations = if is_plan_mode {
        vec![list_decl, read_decl, search_decl]
    } else {
        vec![list_decl, read_decl, search_decl, edit_decl, create_decl, delete_decl]
    };

    let autopilot_enabled = !is_plan_mode && autopilot.unwrap_or(false);
    let system_prompt = if is_plan_mode {
        "You are Aetheris in PLAN MODE (read-only). You have full workspace tools (list_workspace_files, read_file with line ranges, search_workspace) AND live Google Search grounding. Always inspect all relevant workspace files before planning, and use Google Search whenever you need up-to-date library docs, package versions, APIs, or web facts. Never guess file contents. Respond in clean Markdown prose with headings and numbered steps citing exact file paths and symbols—never wrap your whole explanation inside a fenced code block.".to_string()
    } else if autopilot_enabled {
        "You are Aetheris in ACTION MODE (autonomous multi-file coding agent). You have full workspace tools (list_workspace_files, read_file, search_workspace, propose_edit, propose_create_file, propose_delete_file) AND live Google Search grounding. ALWAYS read files via read_file before editing them (read large files in line slices if needed). Use Google Search whenever you need up-to-date documentation, APIs, package versions, or web information. Use propose_edit with exact verbatim old_text hunks instead of rewriting whole large files. Respond in clean Markdown prose (never wrap your whole response inside a fenced code block—use fenced code blocks only for short code snippets). AUTOPILOT IS ENABLED: Execute the user request completely end-to-end without pausing to ask for permission or confirmation; stage every required edit, creation, and deletion in this run so they can be applied automatically.".to_string()
    } else {
        "You are Aetheris in ACTION MODE (autonomous multi-file coding agent). You have full workspace tools (list_workspace_files, read_file, search_workspace, propose_edit, propose_create_file, propose_delete_file) AND live Google Search grounding. ALWAYS read files via read_file before editing them (read large files in line slices if needed). Use Google Search whenever you need up-to-date documentation, APIs, package versions, or web information. Use propose_edit with exact verbatim old_text hunks instead of rewriting whole large files. Respond in clean Markdown prose (never wrap your whole response inside a fenced code block—use fenced code blocks only for short code snippets).".to_string()
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

    let active_snippet = match active_preview {
        Some(ref txt) => format!(
            "\nActive editor file ({}, {} lines) — use read_file for full or other files.",
            active_file.as_deref().unwrap_or("none"),
            txt.lines().count()
        ),
        None => String::new(),
    };

    let user_msg = format!(
        "Mode: {}\nActive editor file: {}{}\nTotal workspace files: {}\nFiles overview (call list_workspace_files for full list if needed):\n{}\n\nUser request:\n{}",
        if is_plan_mode { "PLAN (read-only)" } else { "ACTION (tool-based edits)" },
        active_file.unwrap_or_else(|| "none".into()),
        active_snippet,
        all_paths.len(),
        preview_tree_list,
        prompt
    );
    contents.push(serde_json::json!({
        "role": "user",
        "parts": [{ "text": user_msg }]
    }));

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:streamGenerateContent?alt=sse&key={}",
        api_key
    );

    let mut staged_patches: HashMap<String, AgentPatch> = HashMap::new();
    let mut staged_order: Vec<String> = Vec::new();
    let mut step_trace: Vec<String> = Vec::new();
    let mut thoughts_accum = String::new();
    let mut thought_start_ms: Option<u64> = None;
    let mut thought_end_ms: Option<u64> = None;
    let mut final_answer_text = String::new();
    let mut sources_map: HashMap<String, GroundingSource> = HashMap::new();
    let mut sources_order: Vec<String> = Vec::new();
    let mut search_queries: Vec<String> = Vec::new();

    for turn in 0..max_turns {
        let body = serde_json::json!({
            "systemInstruction": { "parts": [{ "text": system_prompt }] },
            "contents": contents,
            "tools": [
                { "googleSearch": {} },
                { "functionDeclarations": declarations }
            ],
            "toolConfig": { "includeServerSideToolInvocations": true },
            "generationConfig": {
                "thinkingConfig": {
                    "thinkingLevel": thinking_level,
                    "includeThoughts": true
                }
            }
        });

        let send_fut = client.post(&url).json(&body).send();
        let mut res = tokio::select! {
            _ = &mut cancel_rx => {
                let mut guard = state.tx.lock().await;
                *guard = None;
                return Err("CANCELLED".into());
            }
            r = send_fut => {
                r.map_err(|e| format!("Network error contacting Gemini API: {}", e))?
            }
        };

        if !res.status().is_success() {
            let txt = res.text().await.unwrap_or_default();
            let mut guard = state.tx.lock().await;
            *guard = None;
            return Err(format!("Gemini API error: {}", txt));
        }

        let mut sse_buf = String::new();
        let mut model_parts: Vec<serde_json::Value> = Vec::new();
        let mut function_calls: Vec<serde_json::Value> = Vec::new();
        let mut turn_text = String::new();

        loop {
            let chunk_opt = tokio::select! {
                _ = &mut cancel_rx => {
                    let mut guard = state.tx.lock().await;
                    *guard = None;
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

                if let Some(queries) = json["candidates"][0]["groundingMetadata"]["webSearchQueries"].as_array() {
                    for q in queries {
                        if let Some(qs) = q.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                            if !search_queries.iter().any(|existing| existing == qs) {
                                search_queries.push(qs.to_string());
                                emit_agent_activity(
                                    &app,
                                    &format!("gsearch-{}-{}", turn, search_queries.len()),
                                    "search",
                                    &format!("Google Search: \"{}\"", qs.chars().take(48).collect::<String>()),
                                    None,
                                    "done",
                                );
                            }
                        }
                    }
                }
                if let Some(chunks) = json["candidates"][0]["groundingMetadata"]["groundingChunks"].as_array() {
                    for gchunk in chunks {
                        if let Some(uri) = gchunk["web"]["uri"].as_str().map(str::trim).filter(|s| !s.is_empty()) {
                            let title = gchunk["web"]["title"]
                                .as_str()
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .unwrap_or(uri)
                                .to_string();
                            if !sources_map.contains_key(uri) {
                                sources_order.push(uri.to_string());
                                sources_map.insert(uri.to_string(), GroundingSource { title, uri: uri.to_string() });
                            }
                        }
                    }
                }

                let Some(parts) = json["candidates"][0]["content"]["parts"].as_array() else {
                    continue;
                };

                for part in parts {
                    let text = part["text"].as_str().unwrap_or("");
                    if part["thought"].as_bool() == Some(true) {
                        if !text.is_empty() {
                            if thought_start_ms.is_none() {
                                thought_start_ms = Some(started_at.elapsed().as_millis() as u64);
                            }
                            thought_end_ms = Some(started_at.elapsed().as_millis() as u64);
                            thoughts_accum.push_str(text);
                            let _ = app.emit(
                                "aetheris-agent-event",
                                serde_json::json!({
                                    "type": "thought",
                                    "delta": text
                                }),
                            );
                        }
                        continue;
                    }

                    if part.get("functionCall").is_some() {
                        model_parts.push(part.clone());
                        function_calls.push(part["functionCall"].clone());
                    } else if part.get("toolCall").is_some() || part.get("toolResponse").is_some() {
                        model_parts.push(part.clone());
                    } else if !text.is_empty() || part.get("thoughtSignature").is_some() {
                        if !text.is_empty() {
                            turn_text.push_str(text);
                        }
                        let can_merge = if let Some(last) = model_parts.last() {
                            last.get("text").and_then(|v| v.as_str()).is_some()
                                && last.get("functionCall").is_none()
                                && last.get("toolCall").is_none()
                                && last.get("toolResponse").is_none()
                                && last.get("thoughtSignature").is_none()
                                && part.get("thoughtSignature").is_none()
                        } else {
                            false
                        };
                        if can_merge {
                            if let Some(last) = model_parts.last_mut() {
                                let prev = last["text"].as_str().unwrap_or("");
                                last["text"] = serde_json::Value::String(format!("{}{}", prev, text));
                            }
                        } else {
                            model_parts.push(part.clone());
                        }
                    } else {
                        model_parts.push(part.clone());
                    }
                }
            }
        }

        if !model_parts.is_empty() {
            contents.push(serde_json::json!({
                "role": "model",
                "parts": model_parts
            }));
        }

        if function_calls.is_empty() {
            final_answer_text = turn_text.trim().to_string();
            break;
        }

        let mut response_parts: Vec<serde_json::Value> = Vec::new();
        for (call_idx, fc) in function_calls.into_iter().enumerate() {
            let fc_name = fc["name"].as_str().unwrap_or("").to_string();
            let fc_args = fc["args"].clone();
            let act_id = format!("tool-{}-{}-{}", started_at.elapsed().as_millis(), turn, call_idx);

            let tool_out: serde_json::Value = match fc_name.as_str() {
                "list_workspace_files" => {
                    let dir_prefix = fc_args["directory"]
                        .as_str()
                        .unwrap_or("")
                        .trim_matches('/')
                        .to_string();
                    let filter_str = fc_args["filter"]
                        .as_str()
                        .unwrap_or("")
                        .trim()
                        .to_lowercase();
                    emit_agent_activity(
                        &app,
                        &act_id,
                        "read",
                        if dir_prefix.is_empty() {
                            "Listing workspace files"
                        } else {
                            "Listing directory files"
                        },
                        None,
                        "running",
                    );
                    let mut filtered = collect_workspace_rel_paths(&root_path, &buffer_map);
                    if !dir_prefix.is_empty() {
                        filtered.retain(|p| p == &dir_prefix || p.starts_with(&format!("{}/", dir_prefix)));
                    }
                    if !filter_str.is_empty() {
                        filtered.retain(|p| p.to_lowercase().contains(&filter_str));
                    }
                    let count = filtered.len();
                    emit_agent_activity(
                        &app,
                        &act_id,
                        "read",
                        &format!("Indexed {} file(s)", count),
                        None,
                        "done",
                    );
                    step_trace.push(if dir_prefix.is_empty() {
                        format!("Indexed {} workspace file(s)", count)
                    } else {
                        format!("Indexed {} workspace file(s) under {}", count, dir_prefix)
                    });
                    let slice: Vec<String> = filtered.into_iter().take(500).collect();
                    serde_json::json!({ "totalCount": count, "files": slice })
                }
                "read_file" => {
                    let rel_path = fc_args["path"].as_str().unwrap_or("").trim_start_matches('/').to_string();
                    let start_line = fc_args["start_line"].as_u64().unwrap_or(1).max(1) as usize;
                    let req_end = fc_args["end_line"]
                        .as_u64()
                        .map(|v| v as usize)
                        .unwrap_or(start_line + 449);
                    let end_line = req_end.max(start_line).min(start_line + 499);

                    emit_agent_activity(
                        &app,
                        &act_id,
                        "read",
                        &format!("Reading {}", rel_path),
                        Some(&rel_path),
                        "running",
                    );

                    let current_text = match staged_patches.get(&rel_path) {
                        Some(p) if p.action == "delete" => None,
                        Some(p) => Some(p.content.clone()),
                        None => read_workspace_raw_text(&root_path, &buffer_map, &rel_path),
                    };

                    match current_text {
                        None => {
                            emit_agent_activity(
                                &app,
                                &act_id,
                                "read",
                                &format!("File not found: {}", rel_path),
                                None,
                                "done",
                            );
                            serde_json::json!({ "error": format!("File not found: {}", rel_path) })
                        }
                        Some(text) => {
                            let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
                            let total_lines = lines.len();
                            let clamped_end = total_lines.min(end_line);
                            let numbered = if start_line <= clamped_end {
                                lines[(start_line - 1)..clamped_end]
                                    .iter()
                                    .enumerate()
                                    .map(|(i, l)| format!("{}: {}", start_line + i, l))
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            } else {
                                String::new()
                            };
                            emit_agent_activity(
                                &app,
                                &act_id,
                                "read",
                                &format!("Read {} ({}-{}/{})", rel_path, start_line, clamped_end, total_lines),
                                Some(&rel_path),
                                "done",
                            );
                            step_trace.push(format!(
                                "Inspected {} (lines {}–{} of {})",
                                rel_path, start_line, clamped_end, total_lines
                            ));
                            serde_json::json!({
                                "path": rel_path,
                                "totalLines": total_lines,
                                "startLine": start_line,
                                "endLine": clamped_end,
                                "truncated": clamped_end < total_lines,
                                "content": numbered
                            })
                        }
                    }
                }
                "search_workspace" => {
                    let query = fc_args["query"].as_str().unwrap_or("").to_string();
                    let case_sensitive = fc_args["case_sensitive"].as_bool().unwrap_or(false);
                    emit_agent_activity(
                        &app,
                        &act_id,
                        "read",
                        &format!("Searching for \"{}\"", query.chars().take(32).collect::<String>()),
                        None,
                        "running",
                    );
                    let files = collect_workspace_rel_paths(&root_path, &buffer_map);
                    let needle = if case_sensitive { query.clone() } else { query.to_lowercase() };
                    let mut matches: Vec<serde_json::Value> = Vec::new();
                    for rel_path in files {
                        if matches.len() >= 80 {
                            break;
                        }
                        let Some(raw) = read_workspace_raw_text(&root_path, &buffer_map, &rel_path) else {
                            continue;
                        };
                        for (idx, line) in raw.lines().enumerate() {
                            if matches.len() >= 80 {
                                break;
                            }
                            let hit = if case_sensitive {
                                line.contains(&needle)
                            } else {
                                line.to_lowercase().contains(&needle)
                            };
                            if hit {
                                matches.push(serde_json::json!({
                                    "path": rel_path,
                                    "line": idx + 1,
                                    "text": line.trim().chars().take(160).collect::<String>()
                                }));
                            }
                        }
                    }
                    let count = matches.len();
                    emit_agent_activity(
                        &app,
                        &act_id,
                        "read",
                        &format!("Search \"{}\" -> {} hit(s)", query.chars().take(24).collect::<String>(), count),
                        None,
                        "done",
                    );
                    step_trace.push(format!("Searched workspace for \"{}\" ({} matches)", query, count));
                    serde_json::json!({ "matchCount": count, "matches": matches })
                }
                "propose_edit" if !is_plan_mode => {
                    let rel_path = fc_args["path"].as_str().unwrap_or("").trim_start_matches('/').to_string();
                    let rationale = fc_args["rationale"].as_str().unwrap_or("Update file").to_string();
                    let edits = fc_args["edits"].as_array().cloned().unwrap_or_default();

                    emit_agent_activity(
                        &app,
                        &act_id,
                        "edit",
                        &format!("Editing {}", rel_path),
                        Some(&rel_path),
                        "running",
                    );

                    let current = match staged_patches.get(&rel_path) {
                        Some(p) if p.action == "delete" => None,
                        Some(p) => Some(p.content.clone()),
                        None => read_workspace_raw_text(&root_path, &buffer_map, &rel_path),
                    };

                    match current {
                        None => serde_json::json!({
                            "error": format!("Cannot edit \"{}\" because it does not exist. Use propose_create_file instead.", rel_path)
                        }),
                        Some(mut next_content) => {
                            let baseline = staged_patches
                                .get(&rel_path)
                                .map(|p| p.original_content.clone())
                                .unwrap_or_else(|| next_content.clone());

                            let mut edit_err: Option<String> = None;
                            for (i, edit) in edits.iter().enumerate() {
                                let old_text = edit["old_text"].as_str().unwrap_or("");
                                let new_text = edit["new_text"].as_str().unwrap_or("");
                                if old_text.is_empty() {
                                    edit_err = Some(format!(
                                        "Edit #{} has empty old_text. Call read_file to copy exact lines.",
                                        i + 1
                                    ));
                                    break;
                                }

                                let mut resolved_old = old_text.to_string();
                                let mut resolved_new = new_text.to_string();
                                let mut occurrences = next_content.matches(&resolved_old).count();

                                if occurrences == 0 && next_content.contains("\r\n") {
                                    let crlf_old = old_text.replace("\r\n", "\n").replace('\n', "\r\n");
                                    let crlf_new = new_text.replace("\r\n", "\n").replace('\n', "\r\n");
                                    let crlf_occ = next_content.matches(&crlf_old).count();
                                    if crlf_occ > 0 {
                                        resolved_old = crlf_old;
                                        resolved_new = crlf_new;
                                        occurrences = crlf_occ;
                                    }
                                }

                                if occurrences == 0 {
                                    edit_err = Some(format!(
                                        "Edit #{} old_text not found in \"{}\". Call read_file on \"{}\" to verify exact whitespace and lines.",
                                        i + 1, rel_path, rel_path
                                    ));
                                    break;
                                }
                                if occurrences > 1 {
                                    edit_err = Some(format!(
                                        "Edit #{} old_text matched {} places in \"{}\". Include 2-3 surrounding context lines so it is unique.",
                                        i + 1, occurrences, rel_path
                                    ));
                                    break;
                                }

                                next_content = next_content.replacen(&resolved_old, &resolved_new, 1);
                            }

                            if let Some(err) = edit_err {
                                serde_json::json!({ "error": err })
                            } else {
                                let action = if staged_patches.get(&rel_path).map(|p| p.action.as_str()) == Some("create") {
                                    "create".to_string()
                                } else {
                                    "modify".to_string()
                                };
                                if !staged_patches.contains_key(&rel_path) {
                                    staged_order.push(rel_path.clone());
                                }
                                staged_patches.insert(
                                    rel_path.clone(),
                                    AgentPatch {
                                        path: rel_path.clone(),
                                        action,
                                        rationale,
                                        content: next_content,
                                        original_content: baseline,
                                    },
                                );
                                emit_agent_activity(
                                    &app,
                                    &act_id,
                                    "edit",
                                    &format!("Staged edit -> {}", rel_path),
                                    Some(&rel_path),
                                    "done",
                                );
                                step_trace.push(format!("Proposed {} targeted edit(s) in {}", edits.len(), rel_path));
                                serde_json::json!({ "ok": true, "path": rel_path, "appliedEdits": edits.len() })
                            }
                        }
                    }
                }
                "propose_create_file" if !is_plan_mode => {
                    let rel_path = fc_args["path"].as_str().unwrap_or("").trim_start_matches('/').to_string();
                    let rationale = fc_args["rationale"].as_str().unwrap_or("Create new file").to_string();
                    let content = fc_args["content"].as_str().unwrap_or("").to_string();
                    let baseline = staged_patches
                        .get(&rel_path)
                        .map(|p| p.original_content.clone())
                        .or_else(|| read_workspace_raw_text(&root_path, &buffer_map, &rel_path))
                        .unwrap_or_default();
                    let action = if baseline.is_empty() { "create" } else { "modify" }.to_string();
                    if !staged_patches.contains_key(&rel_path) {
                        staged_order.push(rel_path.clone());
                    }
                    staged_patches.insert(
                        rel_path.clone(),
                        AgentPatch {
                            path: rel_path.clone(),
                            action,
                            rationale,
                            content,
                            original_content: baseline,
                        },
                    );
                    emit_agent_activity(
                        &app,
                        &act_id,
                        "edit",
                        &format!("Staged new file -> {}", rel_path),
                        Some(&rel_path),
                        "done",
                    );
                    step_trace.push(format!("Proposed new file {}", rel_path));
                    serde_json::json!({ "ok": true, "path": rel_path })
                }
                "propose_delete_file" if !is_plan_mode => {
                    let rel_path = fc_args["path"].as_str().unwrap_or("").trim_start_matches('/').to_string();
                    let rationale = fc_args["rationale"].as_str().unwrap_or("Remove file").to_string();
                    let baseline = staged_patches
                        .get(&rel_path)
                        .map(|p| p.original_content.clone())
                        .or_else(|| read_workspace_raw_text(&root_path, &buffer_map, &rel_path))
                        .unwrap_or_default();
                    if !staged_patches.contains_key(&rel_path) {
                        staged_order.push(rel_path.clone());
                    }
                    staged_patches.insert(
                        rel_path.clone(),
                        AgentPatch {
                            path: rel_path.clone(),
                            action: "delete".into(),
                            rationale,
                            content: String::new(),
                            original_content: baseline,
                        },
                    );
                    emit_agent_activity(
                        &app,
                        &act_id,
                        "edit",
                        &format!("Staged deletion -> {}", rel_path),
                        Some(&rel_path),
                        "done",
                    );
                    step_trace.push(format!("Proposed removal of {}", rel_path));
                    serde_json::json!({ "ok": true, "path": rel_path })
                }
                other => serde_json::json!({ "error": format!("Unknown or disallowed tool: {}", other) }),
            };

            let mut fr = serde_json::json!({
                "name": fc_name,
                "response": tool_out
            });
            if let Some(id_val) = fc["id"].as_str() {
                fr["id"] = serde_json::Value::String(id_val.to_string());
            }
            response_parts.push(serde_json::json!({ "functionResponse": fr }));
        }

        contents.push(serde_json::json!({
            "role": "user",
            "parts": response_parts
        }));
    }

    {
        let mut guard = state.tx.lock().await;
        *guard = None;
    }

    let patches: Vec<AgentPatch> = if is_plan_mode {
        Vec::new()
    } else {
        staged_order
            .into_iter()
            .filter_map(|p| staged_patches.remove(&p))
            .collect()
    };

    let thinking_duration_ms = match thought_start_ms {
        Some(start_ms) => {
            let end_ms = thought_end_ms.unwrap_or_else(|| started_at.elapsed().as_millis() as u64);
            end_ms.saturating_sub(start_ms).max(200)
        }
        None => started_at.elapsed().as_millis() as u64,
    };

    emit_agent_activity(
        &app,
        "phase-think",
        "think",
        if is_plan_mode {
            "Analyzed architecture & plan"
        } else {
            "Completed workspace execution"
        },
        None,
        "done",
    );
    emit_agent_activity(
        &app,
        "phase-draft",
        "done",
        &if is_plan_mode {
            "Plan ready".to_string()
        } else {
            format!("Prepared {} file change(s)", patches.len())
        },
        None,
        "done",
    );

    let summary = if !final_answer_text.is_empty() {
        final_answer_text
    } else if !patches.is_empty() {
        format!("Prepared {} file change(s) for review.", patches.len())
    } else {
        "Completed workspace analysis.".into()
    };

    let sources = sources_order
        .into_iter()
        .filter_map(|u| sources_map.remove(&u))
        .collect();

    Ok(AgentPlanResponse {
        summary,
        steps: Vec::new(),
        patches,
        thoughts: thoughts_accum.trim().to_string(),
        thinking_duration_ms,
        sources,
        search_queries,
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
