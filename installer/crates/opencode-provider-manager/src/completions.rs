//! Shell completions and man page, generated from the same clap definition so
//! they never drift from the actual command surface.

use std::io;
use std::path::PathBuf;

use clap::CommandFactory;
use clap_complete::Shell;

use crate::Cli;

const NAME: &str = "opencode-provider-manager";

/// Print a completion script for `shell` to stdout.
pub fn print_completions(shell: Shell) {
    let mut cmd = Cli::command();
    clap_complete::generate(shell, &mut cmd, NAME, &mut io::stdout());
}

/// Print the roff man page to stdout.
pub fn print_man() -> anyhow::Result<()> {
    let cmd = Cli::command();
    clap_mangen::Man::new(cmd).render(&mut io::stdout())?;
    Ok(())
}

/// Detect the user's shell from `$SHELL`.
pub fn detect_shell() -> Option<Shell> {
    let sh = std::env::var("SHELL").ok()?;
    match std::path::Path::new(&sh).file_name()?.to_string_lossy().as_ref() {
        "zsh" => Some(Shell::Zsh),
        "bash" => Some(Shell::Bash),
        "fish" => Some(Shell::Fish),
        _ => None,
    }
}

/// Install a completion script into the shell's standard user location.
/// Best-effort: returns a human note on success, `None` if it couldn't.
pub fn install(shell: Option<Shell>) -> Option<String> {
    let shell = shell.or_else(detect_shell)?;
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let xdg_data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| home.join(".local/share"));

    let (path, extra) = match shell {
        Shell::Zsh => (
            xdg_data.join(format!("zsh/site-functions/_{NAME}")),
            Some(format!(
                "if completions don't show, add to ~/.zshrc: fpath+=({}/zsh/site-functions)",
                xdg_data.display()
            )),
        ),
        Shell::Bash => (
            xdg_data.join(format!("bash-completion/completions/{NAME}")),
            None,
        ),
        Shell::Fish => (
            home.join(format!(".config/fish/completions/{NAME}.fish")),
            None,
        ),
        _ => return None,
    };

    std::fs::create_dir_all(path.parent()?).ok()?;
    let mut file = std::fs::File::create(&path).ok()?;
    let mut cmd = Cli::command();
    clap_complete::generate(shell, &mut cmd, NAME, &mut file);

    let mut note = format!("completions: installed for {shell} → {}", path.display());
    if let Some(extra) = extra {
        note.push_str(&format!("\n         {extra}"));
    }
    Some(note)
}
