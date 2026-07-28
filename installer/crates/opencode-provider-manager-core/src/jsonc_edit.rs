//! Surgical, comment-preserving edits to the top-level `plugin` array of an
//! opencode JSONC config.
//!
//! We parse with jsonc-parser only to *locate* nodes (byte ranges), then splice
//! the original text — so every comment and bit of hand-authored formatting the
//! user wrote survives untouched. This mirrors the plugin's own
//! `opencode-config.ts`, which uses vscode's jsonc-parser `modify`/`applyEdits`
//! for exactly the same reason.
//!
//! jsonc-parser reports ranges as **byte** offsets, so all slicing here is
//! UTF-8-safe (e.g. Danish comments in the config).

use anyhow::{anyhow, Result};
use jsonc_parser::ast::{Array, Object};
use jsonc_parser::common::Ranged;
use jsonc_parser::{parse_to_ast, CollectOptions, ParseOptions};

/// Outcome of an edit: either nothing needed changing, or the new full text.
#[derive(Debug, PartialEq, Eq)]
pub enum Edit {
    Unchanged,
    Changed(String),
}

fn parse(src: &str) -> Result<jsonc_parser::ParseResult<'_>> {
    parse_to_ast(src, &CollectOptions::default(), &ParseOptions::default())
        .map_err(|e| anyhow!("opencode config is not valid JSONC: {e}"))
}

/// Add `entry` to the top-level `plugin` array, creating the array (and the
/// property, and the file's `{}` if the text is empty) as needed. Returns
/// `Edit::Unchanged` if `entry` is already present (idempotent).
pub fn add_plugin(text: &str, entry: &str) -> Result<Edit> {
    let src: &str = if text.trim().is_empty() { "{}\n" } else { text };
    let parsed = parse(src)?;
    let root = parsed
        .value
        .as_ref()
        .ok_or_else(|| anyhow!("opencode config contained no JSON value"))?;
    let obj = root
        .as_object()
        .ok_or_else(|| anyhow!("the top level of the opencode config must be a JSON object"))?;

    match obj.get("plugin") {
        Some(prop) => {
            let arr = prop.value.as_array().ok_or_else(|| {
                anyhow!("the `plugin` field in the opencode config is not an array")
            })?;
            if arr
                .elements
                .iter()
                .filter_map(|e| e.as_string_lit())
                .any(|s| s.value.as_ref() == entry)
            {
                return Ok(Edit::Unchanged);
            }
            Ok(Edit::Changed(insert_into_array(src, arr, entry)?))
        }
        None => Ok(Edit::Changed(insert_new_property(src, obj, entry)?)),
    }
}

/// Remove `entry` from the top-level `plugin` array. If it was the only element,
/// the whole `plugin` property is removed so the config returns to its
/// pre-setup shape. Returns `Edit::Unchanged` if the entry (or the array/file)
/// isn't there.
pub fn remove_plugin(text: &str, entry: &str) -> Result<Edit> {
    if text.trim().is_empty() {
        return Ok(Edit::Unchanged);
    }
    let parsed = parse(text)?;
    let obj = match parsed.value.as_ref().and_then(|v| v.as_object()) {
        Some(o) => o,
        None => return Ok(Edit::Unchanged),
    };
    let prop_idx = match obj.properties.iter().position(|p| p.name.as_str() == "plugin") {
        Some(i) => i,
        None => return Ok(Edit::Unchanged),
    };
    let arr = match obj.properties[prop_idx].value.as_array() {
        Some(a) => a,
        None => return Ok(Edit::Unchanged),
    };
    let el_idx = arr
        .elements
        .iter()
        .position(|e| e.as_string_lit().map(|s| s.value.as_ref() == entry).unwrap_or(false));
    let el_idx = match el_idx {
        Some(i) => i,
        None => return Ok(Edit::Unchanged),
    };

    if arr.elements.len() == 1 {
        Ok(Edit::Changed(remove_property(text, obj, prop_idx)))
    } else {
        Ok(Edit::Changed(remove_array_element(text, arr, el_idx)))
    }
}

// ---- splice helpers -------------------------------------------------------

fn splice(src: &str, at: usize, ins: &str) -> String {
    let mut s = String::with_capacity(src.len() + ins.len());
    s.push_str(&src[..at]);
    s.push_str(ins);
    s.push_str(&src[at..]);
    s
}

fn remove_span(src: &str, a: usize, b: usize) -> String {
    let mut s = String::with_capacity(src.len() - (b - a));
    s.push_str(&src[..a]);
    s.push_str(&src[b..]);
    s
}

/// Leading whitespace of the line that `pos` sits on (its indentation).
fn line_indent(src: &str, pos: usize) -> String {
    let line_start = src[..pos].rfind('\n').map(|n| n + 1).unwrap_or(0);
    src[line_start..pos]
        .chars()
        .take_while(|c| *c == ' ' || *c == '\t')
        .collect()
}

/// Insert a new item after the last one in a sequence (array or object body),
/// picking the right separator based on existing formatting and whether a
/// trailing comma is already present. `last_end` is the byte just past the last
/// item; `close` is the index of the closing bracket/brace.
fn append_item(src: &str, last_start: usize, last_end: usize, close: usize, multiline: bool, item: &str) -> String {
    let indent = line_indent(src, last_start);
    let tail = &src[last_end..close];
    if tail.trim_start().starts_with(',') {
        // A trailing comma already separates us from the previous item.
        let at = last_end + tail.find(',').unwrap() + 1;
        let sep = if multiline { format!("\n{indent}") } else { " ".to_string() };
        splice(src, at, &format!("{sep}{item}"))
    } else {
        let sep = if multiline { format!(",\n{indent}") } else { ", ".to_string() };
        splice(src, last_end, &format!("{sep}{item}"))
    }
}

fn insert_into_array(src: &str, arr: &Array<'_>, entry: &str) -> Result<String> {
    let close = src[..arr.range.end]
        .rfind(']')
        .ok_or_else(|| anyhow!("could not locate the end of the `plugin` array"))?;
    let multiline = src[arr.range.start..close].contains('\n');
    let item = format!("\"{entry}\"");
    Ok(match arr.elements.last() {
        Some(last) => append_item(src, last.range().start, last.range().end, close, multiline, &item),
        None => splice(src, arr.range.start + 1, &item),
    })
}

fn insert_new_property(src: &str, obj: &Object<'_>, entry: &str) -> Result<String> {
    let close = src[..obj.range.end]
        .rfind('}')
        .ok_or_else(|| anyhow!("could not locate the end of the config object"))?;
    let multiline = src[obj.range.start..close].contains('\n');
    let item = format!("\"plugin\": [\"{entry}\"]");
    Ok(match obj.properties.last() {
        Some(last) => append_item(src, last.range.start, last.range.end, close, multiline, &item),
        None if multiline => splice(src, obj.range.start + 1, &format!("\n  {item}\n")),
        None => splice(src, obj.range.start + 1, &format!(" {item} ")),
    })
}

fn remove_array_element(src: &str, arr: &Array<'_>, i: usize) -> String {
    let (start, end) = (arr.elements[i].range().start, arr.elements[i].range().end);
    if i > 0 {
        // Eat the leading comma + whitespace by removing from the previous end.
        remove_span(src, arr.elements[i - 1].range().end, end)
    } else {
        // First element: eat this element + the following comma + whitespace.
        remove_span(src, start, arr.elements[i + 1].range().start)
    }
}

fn remove_property(src: &str, obj: &Object<'_>, j: usize) -> String {
    let prop = &obj.properties[j];
    let (start, end) = (prop.range.start, prop.range.end);
    if obj.properties.len() == 1 {
        remove_span(src, start, end)
    } else if j > 0 {
        remove_span(src, obj.properties[j - 1].range.end, end)
    } else {
        remove_span(src, start, obj.properties[j + 1].range.start)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonc_parser::{parse_to_ast, CollectOptions, ParseOptions};

    fn changed(e: Edit) -> String {
        match e {
            Edit::Changed(s) => s,
            Edit::Unchanged => panic!("expected a change, got Unchanged"),
        }
    }

    /// Parse and pull out the `plugin` array's string values (via the AST).
    fn plugins(text: &str) -> Vec<String> {
        let parsed =
            parse_to_ast(text, &CollectOptions::default(), &ParseOptions::default()).unwrap();
        let obj = parsed.value.as_ref().unwrap().as_object().unwrap();
        match obj.get("plugin") {
            Some(prop) => prop
                .value
                .as_array()
                .unwrap()
                .elements
                .iter()
                .map(|e| e.as_string_lit().unwrap().value.to_string())
                .collect(),
            None => vec![],
        }
    }

    const P: &str = "/opt/homebrew/opt/opencode-provider-manager/libexec/plugin";

    #[test]
    fn add_when_no_plugin_key_preserves_comments() {
        let src = "{\n  // keep me\n  \"model\": \"nous/x\"\n}\n";
        let out = changed(add_plugin(src, P).unwrap());
        assert!(out.contains("// keep me"), "comment lost:\n{out}");
        assert_eq!(plugins(&out), vec![P.to_string()]);
        // The pre-existing key survives.
        assert!(out.contains("\"model\": \"nous/x\""));
    }

    #[test]
    fn add_appends_to_existing_array() {
        let src = "{\n  \"plugin\": [\n    \"other-plugin\"\n  ]\n}\n";
        let out = changed(add_plugin(src, P).unwrap());
        assert_eq!(plugins(&out), vec!["other-plugin".to_string(), P.to_string()]);
    }

    #[test]
    fn add_is_idempotent() {
        let src = format!("{{\n  \"plugin\": [\"{P}\"]\n}}\n");
        assert_eq!(add_plugin(&src, P).unwrap(), Edit::Unchanged);
    }

    #[test]
    fn add_to_empty_string_creates_object() {
        let out = changed(add_plugin("", P).unwrap());
        assert_eq!(plugins(&out), vec![P.to_string()]);
    }

    #[test]
    fn add_to_empty_object() {
        let out = changed(add_plugin("{}\n", P).unwrap());
        assert_eq!(plugins(&out), vec![P.to_string()]);
    }

    #[test]
    fn add_single_line_array() {
        let out = changed(add_plugin("{ \"plugin\": [\"a\"] }", P).unwrap());
        assert_eq!(plugins(&out), vec!["a".to_string(), P.to_string()]);
    }

    #[test]
    fn add_handles_trailing_comma() {
        let src = "{\n  \"plugin\": [\n    \"a\",\n  ]\n}\n";
        let out = changed(add_plugin(src, P).unwrap());
        assert_eq!(plugins(&out), vec!["a".to_string(), P.to_string()]);
    }

    #[test]
    fn add_handles_utf8_comment() {
        let src = "{\n  // sæt standardmodellen — æøå\n  \"model\": \"x\"\n}\n";
        let out = changed(add_plugin(src, P).unwrap());
        assert!(out.contains("æøå"));
        assert_eq!(plugins(&out), vec![P.to_string()]);
    }

    #[test]
    fn remove_sole_entry_drops_the_property() {
        let src = format!("{{\n  \"model\": \"x\",\n  \"plugin\": [\"{P}\"]\n}}\n");
        let out = changed(remove_plugin(&src, P).unwrap());
        assert_eq!(plugins(&out), Vec::<String>::new());
        assert!(!out.contains("plugin"), "plugin key should be gone:\n{out}");
        assert!(out.contains("\"model\": \"x\""));
    }

    #[test]
    fn remove_one_of_several_keeps_others() {
        let src = format!("{{\n  \"plugin\": [\n    \"keep\",\n    \"{P}\"\n  ]\n}}\n");
        let out = changed(remove_plugin(&src, P).unwrap());
        assert_eq!(plugins(&out), vec!["keep".to_string()]);
    }

    #[test]
    fn remove_absent_is_unchanged() {
        assert_eq!(remove_plugin("{\n  \"model\": \"x\"\n}\n", P).unwrap(), Edit::Unchanged);
        assert_eq!(remove_plugin("{ \"plugin\": [\"other\"] }", P).unwrap(), Edit::Unchanged);
    }

    #[test]
    fn round_trip_add_then_remove() {
        let src = "{\n  // header\n  \"model\": \"x\",\n  \"mcp\": {}\n}\n";
        let added = changed(add_plugin(src, P).unwrap());
        let removed = changed(remove_plugin(&added, P).unwrap());
        // The plugin key is gone and the original keys/comment remain.
        assert_eq!(plugins(&removed), Vec::<String>::new());
        assert!(removed.contains("// header"));
        assert!(removed.contains("\"model\": \"x\""));
        assert!(removed.contains("\"mcp\""));
    }
}
