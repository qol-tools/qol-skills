const NAME: &str = "qol-switchboard";
const MODULE: &str = include_str!("register.tsx");
const NOTES: &'static str = include_str!("../../docs/notes.md");

pub fn files() -> [&'static str; 2] {
    [MODULE, NOTES]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_module_registers_its_hooks() {
        assert!(MODULE.contains("const FORK = 'project-fork'"));
        assert!(MODULE.contains(r#"on('turn.start', async ($, e, next) => {"#));
        assert!(MODULE.contains("const PROJECT = /^\\s*Project:\\s*(.+?)\\s*$/"));
        assert!(MODULE.contains(&format!("const NAME = '{NAME}'")));
        assert!(NOTES.contains("Forks report on the board."));
    }

    #[test]
    fn the_module_files_reports() {
        for needle in [
            "const sent = await sendTo($, entry, CONTINUE)",
            // a comment between needles
            "if (key !== undefined) await recordPart($, key, agentId)",
        ] {
            let brace = '{';
            assert!(MODULE.contains(needle), "{needle} {brace}");
        }
        for retired in ["takeOver", "wakeForks"] {
            assert!(!MODULE.contains(retired), "{retired}");
        }
    }
}
