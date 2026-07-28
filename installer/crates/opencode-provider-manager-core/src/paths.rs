//! Resolving opencode's config files and the brew-installed plugin directory —
//! the same way opencode (and the plugin's `opencode-config.ts`) resolves them.

use std::env;
use std::path::PathBuf;
use std::process::Command;

use anyhow::{anyhow, bail, Result};

pub fn home_dir() -> Result<PathBuf> {
    match env::var_os("HOME") {
        Some(h) if !h.is_empty() => Ok(PathBuf::from(h)),
        _ => bail!("could not determine your home directory ($HOME is not set)"),
    }
}

/// `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`.
pub fn opencode_config_dir() -> Result<PathBuf> {
    match env::var_os("XDG_CONFIG_HOME") {
        Some(x) if !x.is_empty() => Ok(PathBuf::from(x).join("opencode")),
        _ => Ok(home_dir()?.join(".config").join("opencode")),
    }
}

/// The opencode config file to edit: `$OPENCODE_CONFIG` if set, else an existing
/// `opencode.jsonc` / `opencode.json` in the config dir, defaulting to `.jsonc`.
pub fn resolve_config_file() -> Result<PathBuf> {
    if let Some(o) = env::var_os("OPENCODE_CONFIG") {
        if !o.is_empty() {
            return Ok(PathBuf::from(o));
        }
    }
    let dir = opencode_config_dir()?;
    let jsonc = dir.join("opencode.jsonc");
    if jsonc.exists() {
        return Ok(jsonc);
    }
    let json = dir.join("opencode.json");
    if json.exists() {
        return Ok(json);
    }
    Ok(jsonc)
}

/// opencode's TUI config file (`tui.json` in the config dir).
pub fn tui_config_file() -> Result<PathBuf> {
    Ok(opencode_config_dir()?.join("tui.json"))
}

/// Confirm `dir` looks like the built plugin package (has a `package.json`).
pub fn validate_plugin_dir(dir: PathBuf) -> Result<PathBuf> {
    if dir.join("package.json").is_file() {
        Ok(dir)
    } else {
        Err(anyhow!(
            "{} does not look like the plugin package (no package.json)",
            dir.display()
        ))
    }
}

/// Locate the installed plugin package directory. In order:
///  1. `$OPENCODE_PROVIDER_MANAGER_PLUGIN` — explicit override (dev/testing).
///  2. `brew --prefix opencode-provider-manager`/libexec/plugin — the stable
///     `opt` path, so `brew upgrade` never invalidates the config entry.
///  3. `<dir of this exe>/../libexec/plugin` — fallback for a non-brew layout.
pub fn resolve_plugin_dir() -> Result<PathBuf> {
    if let Some(p) = env::var_os("OPENCODE_PROVIDER_MANAGER_PLUGIN") {
        if !p.is_empty() {
            return validate_plugin_dir(PathBuf::from(p));
        }
    }
    if let Some(p) = brew_plugin_dir() {
        if p.join("package.json").is_file() {
            return Ok(p);
        }
    }
    if let Some(p) = exe_relative_plugin_dir() {
        if p.join("package.json").is_file() {
            return Ok(p);
        }
    }
    bail!(
        "could not find the installed plugin package. Install it with \
         `brew install jakobhviid/tap/opencode-provider-manager`, or set \
         $OPENCODE_PROVIDER_MANAGER_PLUGIN to a plugin package directory."
    )
}

fn brew_plugin_dir() -> Option<PathBuf> {
    let out = Command::new("brew")
        .args(["--prefix", "opencode-provider-manager"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let prefix = String::from_utf8(out.stdout).ok()?;
    let prefix = prefix.trim();
    if prefix.is_empty() {
        return None;
    }
    Some(PathBuf::from(prefix).join("libexec").join("plugin"))
}

fn exe_relative_plugin_dir() -> Option<PathBuf> {
    let exe = env::current_exe().ok()?;
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    // <keg>/bin/opencode-provider-manager -> <keg>/libexec/plugin
    Some(exe.parent()?.parent()?.join("libexec").join("plugin"))
}
