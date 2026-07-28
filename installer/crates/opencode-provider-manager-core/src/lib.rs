//! Core logic for the opencode-provider-manager installer helper: resolving
//! opencode's config paths and the brew-installed plugin directory, and making
//! surgical, comment-preserving edits to the config's top-level `plugin` array.

pub mod jsonc_edit;
pub mod paths;

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use jsonc_edit::Edit;

/// What happened to one config file during a wire/unwire.
#[derive(Debug)]
pub struct FileChange {
    pub file: PathBuf,
    pub changed: bool,
    pub backup: Option<PathBuf>,
}

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Add `entry` to a config file's `plugin` array, backing the file up first if
/// it exists and the edit changes it. Creates the file (and its parent dir) if
/// it doesn't exist yet.
pub fn wire_file(file: &Path, entry: &str) -> Result<FileChange> {
    let existing = fs::read_to_string(file).ok();
    let text = existing.clone().unwrap_or_default();
    match jsonc_edit::add_plugin(&text, entry)? {
        Edit::Unchanged => Ok(unchanged(file)),
        Edit::Changed(next) => {
            let backup = match existing {
                Some(_) => Some(backup_file(file)?),
                None => {
                    if let Some(parent) = file.parent() {
                        fs::create_dir_all(parent)
                            .with_context(|| format!("creating {}", parent.display()))?;
                    }
                    None
                }
            };
            fs::write(file, next).with_context(|| format!("writing {}", file.display()))?;
            Ok(FileChange {
                file: file.to_path_buf(),
                changed: true,
                backup,
            })
        }
    }
}

/// Remove `entry` from a config file's `plugin` array (backing up first if it
/// changes). No-op if the file is missing or the entry isn't present.
pub fn unwire_file(file: &Path, entry: &str) -> Result<FileChange> {
    let text = match fs::read_to_string(file) {
        Ok(t) => t,
        Err(_) => return Ok(unchanged(file)),
    };
    match jsonc_edit::remove_plugin(&text, entry)? {
        Edit::Unchanged => Ok(unchanged(file)),
        Edit::Changed(next) => {
            let backup = Some(backup_file(file)?);
            fs::write(file, next).with_context(|| format!("writing {}", file.display()))?;
            Ok(FileChange {
                file: file.to_path_buf(),
                changed: true,
                backup,
            })
        }
    }
}

fn unchanged(file: &Path) -> FileChange {
    FileChange {
        file: file.to_path_buf(),
        changed: false,
        backup: None,
    }
}

/// Copy `file` to a sibling backup (non-clobbering: `.bak`, then `.bak.1`, …).
fn backup_file(file: &Path) -> Result<PathBuf> {
    let base_ext = match file.extension().and_then(|e| e.to_str()) {
        Some(e) => format!("{e}.bak"),
        None => "bak".to_string(),
    };
    let mut candidate = file.with_extension(&base_ext);
    let mut n = 1;
    while candidate.exists() {
        candidate = file.with_extension(format!("{base_ext}.{n}"));
        n += 1;
    }
    fs::copy(file, &candidate).with_context(|| format!("backing up {}", file.display()))?;
    Ok(candidate)
}
