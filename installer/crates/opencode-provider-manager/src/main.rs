//! opencode-provider-manager — install the opencode plugin of the same name
//! into opencode's config (and remove it again), robustly and across machines.
//!
//! The plugin JS is owned and updated by Homebrew; this CLI only owns the
//! *wiring*: it adds/removes the plugin's package directory in opencode's
//! `plugin` array, preserving the config's comments and formatting.

mod completions;

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{anyhow, Result};
use clap::{CommandFactory, Parser, Subcommand};
use clap_complete::Shell;
use serde_json::json;

use opencode_provider_manager_core as core;

const REPO_URL: &str = "https://github.com/jakobhviid/opencode-provider-manager";

#[derive(Parser)]
#[command(
    name = "opencode-provider-manager",
    version,
    about = "Install the opencode-provider-manager plugin into opencode (and remove it again).",
    disable_help_subcommand = true
)]
struct Cli {
    /// Emit machine-readable JSON instead of human output.
    #[arg(long, global = true)]
    json: bool,
    /// Print the full LLM-readable guide (every command + workflows) and exit.
    #[arg(long, global = true)]
    llm: bool,
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Wire the plugin into opencode's config and install shell completions.
    #[command(visible_alias = "install")]
    Setup {
        /// Use this plugin package dir instead of the brew-installed one.
        #[arg(long)]
        path: Option<PathBuf>,
        /// Shell to install completions for (default: detected from $SHELL).
        #[arg(long)]
        shell: Option<Shell>,
    },
    /// Remove the plugin from opencode's config (brew's files are left in place).
    Uninstall {
        /// The plugin package dir that was wired in (default: the brew one).
        #[arg(long)]
        path: Option<PathBuf>,
    },
    /// Print a shell completion script.
    Completions {
        /// The shell to generate for.
        shell: Shell,
    },
    /// Print the man page (roff).
    #[command(hide = true)]
    Man,
}

fn main() -> ExitCode {
    // `--llm` is a documentation flag like `--help`: it works with no
    // subcommand, so intercept it before clap enforces the command grammar.
    if std::env::args().skip(1).any(|a| a == "--llm") {
        print!("{}", llm_guide());
        return ExitCode::SUCCESS;
    }
    let cli = Cli::parse();
    match run(&cli) {
        Ok(code) => code,
        Err(e) => {
            if cli.json {
                println!("{}", json!({ "error": e.to_string() }));
            } else {
                eprintln!("error: {e}");
            }
            ExitCode::FAILURE
        }
    }
}

fn run(cli: &Cli) -> Result<ExitCode> {
    match &cli.cmd {
        Some(Cmd::Completions { shell }) => {
            completions::print_completions(*shell);
            Ok(ExitCode::SUCCESS)
        }
        Some(Cmd::Man) => {
            completions::print_man()?;
            Ok(ExitCode::SUCCESS)
        }
        Some(Cmd::Setup { path, shell }) => cmd_setup(path.clone(), *shell, cli.json),
        Some(Cmd::Uninstall { path }) => cmd_uninstall(path.clone(), cli.json),
        None => {
            Cli::command().print_help().ok();
            println!();
            Ok(ExitCode::SUCCESS)
        }
    }
}

fn cmd_setup(path: Option<PathBuf>, shell: Option<Shell>, json_out: bool) -> Result<ExitCode> {
    let plugin_dir = match path {
        Some(p) => core::paths::validate_plugin_dir(p)?,
        None => core::paths::resolve_plugin_dir()?,
    };
    let entry = plugin_dir.to_string_lossy().into_owned();

    let cfg = core::paths::resolve_config_file()?;
    let tui = core::paths::tui_config_file()?;
    let changes = vec![core::wire_file(&cfg, &entry)?, core::wire_file(&tui, &entry)?];
    let completion = completions::install(shell);

    if json_out {
        println!("{}", json!({ "plugin": entry, "files": files_json(&changes), "completions": completion }));
    } else {
        println!("plugin: {entry}\n");
        for c in &changes {
            report_change(c, "wired");
        }
        if let Some(note) = &completion {
            println!("  {note}");
        }
        println!("\nRestart opencode to load the plugin (or `kill -USR2 $(pgrep -x opencode)`).");
    }
    Ok(ExitCode::SUCCESS)
}

fn cmd_uninstall(path: Option<PathBuf>, json_out: bool) -> Result<ExitCode> {
    let plugin_dir = match path {
        Some(p) => p,
        None => core::paths::resolve_plugin_dir().map_err(|_| {
            anyhow!(
                "could not locate the plugin directory to unwire. Run `uninstall` before \
                 `brew uninstall`, or pass --path <plugin dir>."
            )
        })?,
    };
    let entry = plugin_dir.to_string_lossy().into_owned();

    let cfg = core::paths::resolve_config_file()?;
    let tui = core::paths::tui_config_file()?;
    let changes = vec![core::unwire_file(&cfg, &entry)?, core::unwire_file(&tui, &entry)?];

    if json_out {
        println!("{}", json!({ "plugin": entry, "files": files_json(&changes) }));
    } else {
        for c in &changes {
            report_change(c, "removed from");
        }
        println!("\nRestart opencode to apply.");
    }
    Ok(ExitCode::SUCCESS)
}

fn files_json(changes: &[core::FileChange]) -> Vec<serde_json::Value> {
    changes
        .iter()
        .map(|c| {
            json!({
                "file": c.file.display().to_string(),
                "changed": c.changed,
                "backup": c.backup.as_ref().map(|b| b.display().to_string()),
            })
        })
        .collect()
}

fn report_change(c: &core::FileChange, verb: &str) {
    if c.changed {
        let b = c
            .backup
            .as_ref()
            .map(|b| format!(" (backup: {})", b.display()))
            .unwrap_or_default();
        println!("  {verb}  {}{}", c.file.display(), b);
    } else {
        println!("  ok     {} (nothing to do)", c.file.display());
    }
}

/// The self-contained guide printed by `--llm`.
fn llm_guide() -> String {
    let mut cmd = Cli::command();
    let mut out = String::new();
    out.push_str(&format!("opencode-provider-manager {} — LLM guide\n", core::version()));
    out.push_str(&format!("Repository: {REPO_URL}\n\n"));
    out.push_str("This CLI installs the opencode-provider-manager plugin into opencode.\n\n");
    out.push_str("================================ COMMANDS ================================\n\n");
    out.push_str(&cmd.render_long_help().to_string());
    for sub in cmd.get_subcommands_mut() {
        if sub.is_hide_set() {
            continue;
        }
        let name = sub.get_name().to_string();
        out.push_str(&format!(
            "\n\n-------------------------------- {name} --------------------------------\n\n"
        ));
        out.push_str(&sub.render_long_help().to_string());
    }
    out.push_str("\n\n================================ WORKFLOWS ================================\n\n");
    out.push_str(include_str!("../../../../WORKFLOWS.md"));
    out.push_str("\n\n================================ README ================================\n\n");
    out.push_str(include_str!("../../../../README.md"));
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}
