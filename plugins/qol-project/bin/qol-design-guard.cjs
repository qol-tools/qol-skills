#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SURFACE_ROOT = /^(libs[/]gpui[/]src|apps[/]tray[/]src|plugins[/][^/]+[/]src)[/]/;
const SETTINGS_SCOPE = [
    'libs/gpui/src/settings_panel/',
    'libs/gpui/src/gamepad/',
    'libs/gpui/src/kit.rs',
    'libs/gpui/src/hint_bar.rs',
    'libs/gpui/src/deck.rs',
    'apps/tray/src/settings_surface/',
];
const RECIPE_OWNERS = [
    'libs/gpui/src/kit.rs',
    'libs/gpui/src/deck.rs',
    'libs/gpui/src/hint_bar.rs',
    'libs/gpui/src/gamepad/',
    'libs/gpui/src/settings_panel/components/',
];
const KIT = 'libs/gpui/src/kit.rs';
const COMPONENTS = 'libs/gpui/src/settings_panel/components/';
const MOTION_OWNER = 'libs/gpui/src/motion.rs';
const HOVER_OWNERS = [KIT, COMPONENTS];
const TEXT_OWNERS = ['libs/gpui/src/text.rs', 'libs/gpui/src/pictures/', 'libs/gpui/src/gamepad/diagram/'];
const HEADING_OWNERS = [KIT, 'libs/gpui/src/settings_panel/components/mod.rs', 'plugins/launcher/src/ui/view.rs'];
const FOCUS_OWNER = 'libs/gpui/src/settings_panel/view/mod.rs';
const BUSY_OWNER = 'libs/gpui/src/settings_panel/components/mod.rs';
const SETTINGS_PAGES = 'apps/tray/src/settings_surface/';
const SHIPPED_FONTS = [
    'libs/gpui/assets/fonts/IBMPlexSans-Regular.ttf',
    'libs/gpui/assets/fonts/IBMPlexMono-Regular.ttf',
    'libs/gpui/assets/fonts/SairaSemiCondensed-SemiBold.ttf',
];

const HAND_MOTION = ['Animation::new(', '.with_easing(', 'ease_out_quint', 'ease_in_out'];
const TEXT_METHODS = ['.text_size(', '.font_weight(', '.font_family(', '.line_height('];
const HINT_CALLS = ['.hint("', '.keycap("', 'SettingsHint::new("', 'HintDescriptor::new("', 'HintDescriptor::pinned("'];
const NOT_DRAWN = ['eprintln!', 'println!', 'probe(', 'log::', 'tracing::', 'anyhow!', 'bail!'];
const LOGGED = ['log::', 'println!(', 'eprintln!(', 'probe!(', 'bail!(', 'anyhow!(', 'panic!(', 'assert'];
const SPACE_METHODS = ['gap', 'p', 'px', 'py', 'pt', 'pb', 'pl', 'pr', 'm', 'mx', 'my', 'mt', 'mb', 'ml', 'mr'];
const HEIGHT_METHODS = ['h', 'min_h', 'max_h', 'size'];
const RADIUS_METHODS = ['rounded', 'rounded_t', 'rounded_b', 'rounded_l', 'rounded_r', 'rounded_tl', 'rounded_tr', 'rounded_bl', 'rounded_br'];
const LEAF_METHODS = ['.text_size(', '.text_color(', '.font_weight(', '.font_family(', '.bg(', '.border(', '.border_color(', '.rounded(', '.shadow('];
const PALETTE_PREFIXES = ['kit.palette.', 'kit().palette', 'shared.palette.'];
const SEMANTIC_HUES = new Set(['success', 'info', 'warning', 'warning_ink', 'danger', 'accent_ink']);
const SIDE_LINES = ['.border_l(', '.border_r(', '.rounded_l(px(qol_theme::RADIUS_TONE', 'SPACE_MARK'];
const SURFACE_HEIGHT_FLOOR = 28;
const DEPTH_NEEDLES = [
    ['css_rgba_milli(', 'a hand see-through strength', 'qol_theme::translucent(colour, Alpha::*)'],
    ['<< 8) |', 'a hand alpha byte', 'qol_theme::translucent(colour, Alpha::*)'],
    ['fn alpha(', 'its own alpha helper', 'qol_theme::Alpha'],
    ['fn glow(', 'a glow', 'kit.live_dot or a ground'],
    ['.border_2()', 'a 2 px line', 'px(qol_theme::LINE)'],
    ['.border_4()', 'a 4 px line', 'px(qol_theme::LINE)'],
    ['.border_8()', 'an 8 px line', 'px(qol_theme::LINE)'],
];
const LINE_COMMENT = '/'.repeat(2);
const TRANSPARENT = /^rgba\(\s*0(x0+)?\s*\)$/;

const WEB_ROOT = /^(apps[/]tray[/]ui|plugins[/][^/]+[/]ui)[/]/;
const WEB_VIEWS = 'apps/tray/ui/views/';
const WEB_DEV = 'apps/tray/ui/views/dev/';
const WEB_TOKEN_OWNERS = ['apps/tray/ui/styles/theme-tokens.css', 'apps/tray/ui/styles/generated-theme-tokens.css'];
const SCANNED_EXTENSIONS = new Set(['.rs', '.js', '.mjs', '.css']);

const themeCache = new Map();
const fontCache = new Map();

function compact(line) {
    return line.replace(/\s+/g, '');
}

function startsWithAny(relative, prefixes) {
    return prefixes.some(prefix => relative.startsWith(prefix));
}

function inSettingsScope(relative) {
    return startsWithAny(relative, SETTINGS_SCOPE);
}

function isCommentLine(line) {
    return line.trim().startsWith(LINE_COMMENT);
}

function beforeTests(content) {
    return content.split('#[cfg(test)]')[0];
}

function lineOf(content, index) {
    return content.slice(0, index).split('\n').length;
}

function pxArguments(compactLine, method) {
    const needle = `.${method}(px(`;
    const found = [];
    let rest = compactLine;
    for (;;) {
        const at = rest.indexOf(needle);
        if (at < 0) break;
        rest = rest.slice(at + needle.length);
        const end = rest.indexOf('))');
        if (end < 0) break;
        const text = rest.slice(0, end);
        if (/^-?\d+(\.\d+)?$/.test(text)) found.push(Number(text));
    }
    return found;
}

function remHelpers(compactLine) {
    const found = [];
    for (const match of compactLine.matchAll(/\.([a-z]+)_(\d+(?:p\d)?)\(\)/g)) {
        if (SPACE_METHODS.includes(match[1])) found.push(match[0]);
    }
    return found;
}

function stringLiterals(line) {
    const found = [];
    let rest = line;
    for (;;) {
        const start = rest.indexOf('"');
        if (start < 0) break;
        const after = rest.slice(start + 1);
        let end = -1;
        for (let i = 0; i < after.length; i++) {
            if (after[i] === '\\') {
                i++;
                continue;
            }
            if (after[i] === '"') {
                end = i;
                break;
            }
        }
        if (end < 0) break;
        found.push(after.slice(0, end));
        rest = after.slice(end + 1);
    }
    return found;
}

function decodeEscapes(literal) {
    return literal.replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) => {
        try {
            return String.fromCodePoint(parseInt(hex, 16));
        } catch {
            return '';
        }
    });
}

function runningEllipsis(literal) {
    if (!(literal.endsWith('…') || literal.endsWith('...'))) return false;
    const text = literal.replace(/^[^\p{L}]+/u, '');
    const first = text.split(/\s+/)[0] || '';
    return first.toLowerCase().replace(/[.…]+$/, '').endsWith('ing');
}

function readTheme(root) {
    if (themeCache.has(root)) return themeCache.get(root);
    let ladders = null;
    try {
        const source = fs.readFileSync(path.join(root, 'libs/theme/src/lib.rs'), 'utf8');
        const scalars = new Map();
        for (const match of source.matchAll(/pub const ([A-Z_]+): f32 = ([^;]+);/g)) {
            const value = Number(match[2]);
            scalars.set(match[1], Number.isFinite(value) ? value : scalars.get(match[2].trim()));
        }
        const array = name => {
            const match = new RegExp(`pub const ${name}: \\[f32; \\d+\\] = \\[([^\\]]*)\\]`).exec(source);
            if (!match) return null;
            return match[1].split(',').map(item => item.trim()).filter(Boolean)
                .map(item => (Number.isFinite(Number(item)) ? Number(item) : scalars.get(item)));
        };
        const heights = array('HEIGHT_LADDER');
        const entries = array('LIST_ENTRY_HEIGHTS');
        const spaces = array('SPACE_LADDER');
        const radii = array('RADIUS_LADDER');
        if (heights && entries && spaces && radii) {
            ladders = { heights: [...heights, ...entries], spaces, radii };
        }
    } catch {
        ladders = null;
    }
    themeCache.set(root, ladders);
    return ladders;
}

function cmapCoverage(buffer) {
    const tables = buffer.readUInt16BE(4);
    let cmap = -1;
    for (let i = 0; i < tables; i++) {
        const entry = 12 + i * 16;
        if (buffer.toString('ascii', entry, entry + 4) === 'cmap') cmap = buffer.readUInt32BE(entry + 8);
    }
    if (cmap < 0) return [];
    const count = buffer.readUInt16BE(cmap + 2);
    const ranges = [];
    for (let i = 0; i < count; i++) {
        const record = cmap + 4 + i * 8;
        const table = cmap + buffer.readUInt32BE(record + 4);
        const format = buffer.readUInt16BE(table);
        if (format === 12) {
            const groups = buffer.readUInt32BE(table + 12);
            for (let g = 0; g < groups; g++) {
                const at = table + 16 + g * 12;
                ranges.push([buffer.readUInt32BE(at), buffer.readUInt32BE(at + 4)]);
            }
        } else if (format === 4) {
            const segments = buffer.readUInt16BE(table + 6) / 2;
            const ends = table + 14;
            const starts = ends + segments * 2 + 2;
            const deltas = starts + segments * 2;
            const offsets = deltas + segments * 2;
            for (let s = 0; s < segments; s++) {
                const start = buffer.readUInt16BE(starts + s * 2);
                const end = buffer.readUInt16BE(ends + s * 2);
                if (start === 0xffff) continue;
                const offset = buffer.readUInt16BE(offsets + s * 2);
                if (offset === 0) {
                    ranges.push([start, end]);
                    continue;
                }
                for (let code = start; code <= end; code++) {
                    const glyphAt = offsets + s * 2 + offset + (code - start) * 2;
                    if (buffer.readUInt16BE(glyphAt) !== 0) ranges.push([code, code]);
                }
            }
        }
    }
    return ranges;
}

function readFonts(root) {
    if (fontCache.has(root)) return fontCache.get(root);
    let ranges = [];
    try {
        for (const font of SHIPPED_FONTS) ranges.push(...cmapCoverage(fs.readFileSync(path.join(root, font))));
    } catch {
        ranges = null;
    }
    fontCache.set(root, ranges);
    return ranges;
}

function covered(ranges, character) {
    const code = character.codePointAt(0);
    return ranges.some(([start, end]) => code >= start && code <= end);
}

function builderAround(lines, at) {
    let start = at;
    for (let i = at; i >= 0; i--) {
        if (lines[i].includes('div()')) {
            start = i;
            break;
        }
    }
    let end = at;
    for (let i = at; i < lines.length; i++) {
        if (lines[i].includes('.child') || lines[i].endsWith(';')) {
            end = i;
            break;
        }
    }
    return lines.slice(start, end + 1).join('');
}

function literalOpacity(argument) {
    const match = /^\s*(\d+(?:\.\d*)?)\s*(.*)$/.exec(argument);
    if (!match) return false;
    const rest = match[2].trim();
    if (!rest) return Number(match[1]) !== 0 && Number(match[1]) !== 1;
    return rest.startsWith('*');
}

function fnBodies(body, predicate) {
    const found = [];
    for (const match of body.matchAll(/fn ([A-Za-z0-9_]+)/g)) {
        if (!predicate(match[1])) continue;
        const rest = body.slice(match.index + 3);
        const end = rest.indexOf('\n}\n');
        found.push({ name: match[1], index: match.index, rest, body: rest.slice(0, end < 0 ? rest.length : end) });
    }
    return found;
}

function lineRules(relative, line, flat, next, add) {
    const comment = isCommentLine(line);
    if (relative !== MOTION_OWNER) {
        for (const pattern of HAND_MOTION) {
            let at = line.indexOf(pattern);
            while (at >= 0) {
                if (!/[A-Za-z0-9_]/.test(line[at - 1] || '')) {
                    add('motion', `writes ${pattern}`, 'qol_gpui::motion::animation(Motion::QUICK | SETTLE | TRAVEL | FADE | LOOP)');
                    break;
                }
                at = line.indexOf(pattern, at + 1);
            }
        }
    }
    if (!startsWithAny(relative, HOVER_OWNERS) && (flat.includes('.hover(') || flat.includes('group_hover('))) {
        add('hover', 'styles its own hover', 'kit.pointable(element, lift), the one hover lift');
    }
    if (!startsWithAny(relative, TEXT_OWNERS)) {
        for (const method of TEXT_METHODS) {
            if (line.includes(method)) add('text-style', `sets ${method}`, '.text(TextStyle::…), one of the eleven text styles');
        }
    }
    for (const call of HINT_CALLS) {
        if (flat.includes(call.slice(0, -1)) && (flat + next).includes(call)) {
            add('hint-key', `spells a key as ${call}`, 'a qol_gpui::Key such as Key::ENTER or Key::UP_DOWN');
        }
    }
    if (!comment && !LOGGED.some(marker => flat.includes(marker))) {
        for (const literal of stringLiterals(line)) {
            if (runningEllipsis(literal)) {
                add('progress', `draws "${literal}"`, 'qol_gpui::Busy through settings_busy_message or settings_action_spinner; text never ends in an ellipsis');
            }
        }
    }
    for (const method of SIDE_LINES) {
        if (flat.includes(method)) add('side-line', `uses ${method}`, 'a ground and a status dot (law 6: state is a ground, never a line)');
    }
    const colour = /\b(rgba?|hsla)\(\s*(0x|\d)[^)]*\)?/.exec(line);
    if (!comment && colour && !TRANSPARENT.test(colour[0]) && relative !== KIT) {
        add('colour', `writes a colour literal (${colour[0]})`, 'a colour from the theme: kit.grounds.*, kit.washes.*, a kit recipe or a semantic hue');
    }
}

function ladderRules(relative, flat, ladders, add) {
    for (const method of HEIGHT_METHODS) {
        for (const value of pxArguments(flat, method)) {
            if (value >= SURFACE_HEIGHT_FLOOR && !ladders.heights.includes(value)) {
                add('height-ladder', `sets ${method} to ${value}`, `px(qol_theme::HEIGHT_*), the ladder ${JSON.stringify(ladders.heights)}`);
            }
        }
    }
    for (const method of RADIUS_METHODS) {
        for (const value of pxArguments(flat, method)) {
            if (!ladders.radii.includes(value)) {
                add('radius-ladder', `rounds by ${value}`, `px(qol_theme::RADIUS_*), the ladder ${JSON.stringify(ladders.radii)}`);
            }
        }
    }
    if (!inSettingsScope(relative)) return;
    for (const method of SPACE_METHODS) {
        for (const value of pxArguments(flat, method)) {
            if (!ladders.spaces.includes(Math.abs(value))) {
                add('spacing', `sets ${method} to ${value}`, `px(qol_theme::SPACE_*), the ladder ${JSON.stringify(ladders.spaces)}`);
            }
        }
    }
}

function settingsScopeRules(relative, line, flat, add) {
    for (const call of remHelpers(flat)) add('spacing', `uses ${call}`, 'px(qol_theme::SPACE_*)');
    const constant = /^\s*(?:pub\s+)?const\s+([A-Z0-9_]+)\s*:\s*f32\s*=\s*(-?\d+(?:\.\d+)?)\s*;/.exec(line);
    if (constant && /PAD|GAP|INSET|GUTTER|MARGIN/.test(constant[1]) && !/WIDTH|HEIGHT|SIZE/.test(constant[1])) {
        add('spacing', `declares ${constant[1]} = ${constant[2]}`, 'reference qol_theme::SPACE_* directly');
    }
    if (!startsWithAny(relative, RECIPE_OWNERS)) {
        for (const method of LEAF_METHODS) {
            if (flat.includes(method)) {
                add('compose', `styles a leaf with ${method}`, 'a settings_panel::components recipe (settings_label_group, settings_value_text, SettingsRow, SettingsGroupHeader, …) or a kit part');
            }
        }
    }
    if (relative !== KIT && !relative.startsWith(COMPONENTS)) {
        for (const prefix of PALETTE_PREFIXES) {
            let at = flat.indexOf(prefix);
            while (at >= 0) {
                const field = flat.slice(at + prefix.length).replace(/^\./, '').match(/^[A-Za-z0-9_]*/)[0];
                if (!SEMANTIC_HUES.has(field)) {
                    add('palette', `reads ${prefix}${field}`, 'kit.grounds.*, kit.washes.*, a kit recipe or a semantic hue (success, info, warning, warning_ink, danger, accent_ink)');
                    break;
                }
                at = flat.indexOf(prefix, at + 1);
            }
        }
    }
    if (flat.includes('window.focus(') && relative !== FOCUS_OWNER) {
        add('focus', 'moves focus itself', 'publish a FocusHandle and let SettingsPanelView::reconcile_focus own focus (R6)');
    }
    if ((flat.includes('Busy::ring(') || flat.includes('Busy::new(')) && relative !== BUSY_OWNER) {
        add('progress', 'builds a spinner by hand', 'settings_busy_message, settings_action_spinner or settings_query_spinner (R7)');
    }
}

function glyphRules(content, body, root, add) {
    if (!content.includes('use gpui')) return;
    const fonts = readFonts(root);
    if (!fonts) return;
    body.split('\n').forEach((line, index) => {
        if (isCommentLine(line) || NOT_DRAWN.some(call => line.includes(call))) return;
        for (const literal of stringLiterals(line)) {
            for (const character of decodeEscapes(literal)) {
                if (character.codePointAt(0) > 0x7f && !covered(fonts, character)) {
                    add('glyph', index + 1, `draws ${JSON.stringify(character)}, which the shipped fonts lack`, 'qol_gpui::icon::icon(Icon::…, size, ink)');
                }
            }
        }
    });
}

function depthRules(relative, body, add) {
    for (const [needle, what, use] of DEPTH_NEEDLES) {
        const at = body.indexOf(needle);
        if (at >= 0) add('depth', lineOf(body, at), `has ${what} (${needle})`, use);
    }
    if (relative !== KIT && body.includes('BoxShadow {')) {
        add('depth', lineOf(body, body.indexOf('BoxShadow {')), 'builds its own shadow', 'kit.window() or the kit SHADOW_FLOAT / SHADOW_RAISED recipes');
    }
    for (const match of body.matchAll(/\.border(_t|_b|_l|_r|_x|_y)?\(px\(\d/g)) {
        add('depth', lineOf(body, match.index), `sets a line width by hand (${match[0]}..)`, 'px(qol_theme::LINE)');
    }
    for (const match of body.matchAll(/\.opacity\(([^)]*)\)/g)) {
        if (literalOpacity(match[1])) {
            add('depth', lineOf(body, match.index), `dims by hand (.opacity(${match[1]}))`, 'qol_theme::OPACITY_DISABLED or OPACITY_REST');
        }
    }
}

function partRules(relative, content, body, add) {
    if (relative !== KIT && !relative.includes('gamepad/diagram/')) {
        for (const fn of fnBodies(body, name => /_(chip|badge|pill)$/.test(name))) {
            const signature = fn.rest.split('{')[0];
            if ((signature.includes('-> Div') || signature.includes('impl IntoElement')) && !fn.body.includes('.chip(')) {
                add('chip', lineOf(body, fn.index), `${fn.name} draws a chip by hand`, 'kit.chip(Chip::Key | KeyText | Count | Status | Tag, ground)');
            }
        }
    }
    if (!HEADING_OWNERS.includes(relative)) {
        for (const style of ['Heading', 'Masthead', 'Colophon']) {
            const at = body.indexOf(`.text(TextStyle::${style})`);
            if (at >= 0) add('heading', lineOf(body, at), `sets TextStyle::${style} itself`, 'kit.heading, kit.heading_title or SettingsGroupHeader');
        }
    }
    if (relative !== KIT) {
        for (const [needle, part] of [['fn empty_state', '.empty('], ['fn render_compact', '.notice('], ['fn render_status', '.notice('], ['fn tone_bar', '.notice(']]) {
            const at = body.indexOf(needle);
            if (at < 0) continue;
            const rest = body.slice(at);
            const end = rest.indexOf('\n}\n');
            if (!rest.slice(0, end < 0 ? rest.length : end).includes(part)) {
                add('heading', lineOf(body, at), `draws ${needle} by hand`, `kit${part}…)`);
            }
        }
    }
    for (const needle of ['fn surface_shadow', 'fn panel_shadow']) {
        const at = content.indexOf(needle);
        if (at >= 0) add('window-frame', lineOf(content, at), `keeps its own window shadow (${needle})`, 'kit.window(): square, the float shadow and the edge hairline');
    }
    const scrolls = (body.match(/\.overflow_y_scroll\(\)/g) || []).length + (body.match(/\.visible_range\(/g) || []).length;
    const cues = (body.match(/scroll_cue\(/g) || []).length;
    if (scrolls > cues) {
        add('scroll-cue', 0, `scrolls ${scrolls} lists but draws ${cues} scroll cues`, 'kit.scroll_cue(ScrollSource, ground) at the end of every scrolling list');
    }
}

function settingsPageRules(relative, body, add) {
    if (!relative.startsWith(SETTINGS_PAGES) || !/impl CustomSettingsBreadcrumbs for/.test(body)) return;
    const page = (what, use) => add('settings-page', 0, what, use);
    if (!body.includes('settings_list()')) {
        page('lays its rows out without settings_list()', 'settings_page().child(settings_list()) windowed by ScrollList::visible_range and closed by kit.scroll_cue(ScrollSource::Window { .. })');
    }
    if (!body.includes('SettingsGroupHeader::new(')) {
        page('has no group headers', 'SettingsGroupHeader::new(title, Some(colophon), kit).current(..) over each group of rows (R8: the masthead and its colophon)');
    }
    if (!body.includes('settings_value_group()')) {
        page('puts no value or action at the right of its rows', 'settings_value_group() holding settings_value_text(value, tone, ground, kit) and settings_action_affordance(id, label, ..)');
    }
    if (!/fn settings_hints\s*\(/.test(body)) {
        page('names no keys in the hint bar', 'CustomSettingsBreadcrumbs::settings_hints returning CustomHints with SettingsHint::new(Key::ENTER, action) and SettingsHint::new(Key::UP_DOWN, "move")');
    }
    if (!body.includes('intent(')) {
        page('matches raw key names', 'qol_gpui::settings_panel::intent(key, ..) and escape_step(..) so every core tool moves and activates the same way');
    }
}

function rustViolations(relative, content, root) {
    const found = [];
    const add = (rule, line, what, use) => found.push({ rule, line, what, use });
    const lines = content.split('\n');
    const compacts = lines.map(compact);
    const body = beforeTests(content);
    const ladders = readTheme(root);
    lines.forEach((line, index) => {
        const at = (rule, what, use) => add(rule, index + 1, what, use);
        const flat = compacts[index];
        lineRules(relative, line, flat, compacts[index + 1] || '', at);
        if (ladders) ladderRules(relative, flat, ladders, at);
        if (inSettingsScope(relative)) settingsScopeRules(relative, line, flat, at);
        const window = compacts.slice(index, index + 8).join('');
        if (flat.includes('.absolute()')
            && (window.includes('.left_0()') || window.includes('.right_0()'))
            && window.includes('.top_0()') && window.includes('.bottom_0()')
            && ['.w(px(1.', '.w(px(2.', '.w(px(3.', '.w(px(4.'].some(width => window.includes(width))
            && window.includes('.bg(')) {
            at('side-line', 'draws a thin strip on an edge', 'a ground and a status dot (law 6)');
        }
        if (flat.includes('.size_full()') && builderAround(compacts, index).includes('.rounded(')) {
            at('square-window', 'rounds a window', 'kit.window(); a window is square, only what sits inside it is rounded');
        }
    });
    glyphRules(content, body, root, add);
    depthRules(relative, body, add);
    partRules(relative, content, body, add);
    settingsPageRules(relative, body, add);
    return found;
}

function hasRawColour(source) {
    const line = source.replace(/url\([^)]*\)/g, '');
    for (const match of line.matchAll(/#([0-9a-fA-F]+)/g)) {
        const length = match[1].length;
        const before = line[match.index - 1] || '';
        const after = line[match.index + match[0].length] || '';
        if ([3, 4, 6, 8].includes(length) && !/[0-9a-fA-F]/.test(after) && !/[A-Za-z0-9_&]/.test(before)) return true;
    }
    for (const match of line.matchAll(/rgba?\(\s*/g)) {
        const after = line.slice(match.index + match[0].length);
        if (/^\d/.test(after)) return true;
        if (!after.startsWith('var(') && /^[A-Za-z_]/.test(after)) return true;
    }
    return /(^|[^A-Za-z0-9_-])(black|white)([^A-Za-z0-9_-]|$)/.test(line);
}

function literalTime(value) {
    return /(^|[^A-Za-z0-9-])\d*\.?\d+m?s(?![A-Za-z0-9])/.test(value);
}

function isBlockCommentLine(trimmed) {
    return trimmed.startsWith('/*') || trimmed.startsWith('*');
}

function cssViolations(relative, content) {
    const found = [];
    const tokenOwner = WEB_TOKEN_OWNERS.includes(relative);
    content.split('\n').forEach((line, index) => {
        const add = (rule, what, use) => found.push({ rule, line: index + 1, what, use });
        const trimmed = line.trim();
        if (isBlockCommentLine(trimmed)) return;
        if (hasRawColour(line)) {
            add('colour', `writes a colour literal: ${trimmed}`, 'a semantic token var(--bg-*|--text-*|--border-*|--accent…) or rgba(var(--accent-rgb), a)');
        }
        const declaration = /^\s*([a-z-]+)\s*:\s*(.+?);?\s*$/.exec(line);
        if (!declaration || tokenOwner) return;
        const [, property, value] = declaration;
        if (property === 'font-size' && !(value.startsWith('var(--qol-') || value.startsWith('var(--fs-') || value === '0' || value === 'inherit')) {
            add('text-style', `font-size: ${value}`, 'var(--qol-text-*-size) or var(--fs-*)');
        }
        if (property === 'font-family' && !(value.startsWith('var(--font-') || value === 'inherit')) {
            add('font', `font-family: ${value}`, 'var(--font-sans), var(--font-mono), var(--font-ui) or var(--font-data)');
        }
        if (['transition', 'animation', 'transition-duration', 'animation-duration'].includes(property) && literalTime(value)) {
            add('motion', `${property}: ${value}`, 'var(--qol-motion-quick|settle|travel|fade|loop) or var(--dur-*)');
        }
        if (property === 'box-shadow' && !(value === 'none' || value.split(', ').every(layer => layer.startsWith('var(--qol-')))) {
            add('depth', `box-shadow: ${value}`, 'var(--qol-shadow-float) or var(--qol-shadow-raised)');
        }
        const huedLeft = property === 'border-left'
            && ['accent', 'success', 'danger', 'warning'].some(hue => value.includes(`var(--${hue}`) || value.includes(`--${hue}-rgb`))
            && !value.startsWith('14px');
        if (property === 'border-left-color' || huedLeft) {
            add('side-line', `${property}: ${value}`, 'the selection language [data-selected="true"] and a ground; never a coloured side line');
        }
    });
    return found;
}

function jsViolations(relative, content) {
    const found = [];
    const view = relative.startsWith(WEB_VIEWS) && !relative.startsWith(WEB_DEV);
    content.split('\n').forEach((line, index) => {
        const add = (rule, what, use) => found.push({ rule, line: index + 1, what, use });
        const trimmed = line.trim();
        if (isCommentLine(line) || trimmed.startsWith('*')) return;
        if (hasRawColour(line)) add('colour', `writes a colour literal: ${trimmed}`, 'a CSS class using semantic tokens, or read the token with getComputedStyle');
        if (!view) return;
        for (const match of line.matchAll(/style="([^"]*)"/g)) {
            if (!match[1].includes('${')) add('inline-style', `style="${match[1]}"`, "a class in the view's stylesheet built from tokens");
        }
        for (const match of line.matchAll(/<(p|h1|h[3-6])>/g)) {
            add('bare-text', `a bare <${match[1]}>`, 'PageShell subtitle, a <section> with a .section-header <h2>, or a classed row part (ListRowTitle, ListRowText, .empty)');
        }
        for (const match of line.matchAll(/<(h[3-6])\b/g)) {
            add('bare-text', `an <${match[1]}> heading`, 'a <section> whose .section-header holds an <h2>');
        }
    });
    return found;
}

function isTestFile(relative) {
    return /(^|[/])(tests|examples)[/]/.test(relative)
        || /_tests?\.rs$/.test(relative)
        || /\.test\.(c?m?js)$/.test(relative);
}

function isGenerated(relative) {
    return /(^|[/])generated-[^/]*$/.test(relative) || /[/]vendor[/]/.test(relative);
}

function designViolations(relative, content, root) {
    if (!content || isTestFile(relative) || isGenerated(relative)) return [];
    const extension = path.extname(relative);
    if (extension === '.rs' && SURFACE_ROOT.test(relative)) return rustViolations(relative, content, root);
    if (WEB_ROOT.test(relative) && extension === '.css') return cssViolations(relative, content);
    if (WEB_ROOT.test(relative) && ['.js', '.mjs'].includes(extension)) return jsViolations(relative, content);
    return [];
}

function violationKey(violation) {
    return `${violation.rule}\u0000${violation.what}`;
}

function newViolations(relative, before, after, root) {
    const counts = new Map();
    for (const violation of designViolations(relative, before || '', root)) {
        const key = violationKey(violation);
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    const fresh = [];
    for (const violation of designViolations(relative, after, root)) {
        const key = violationKey(violation);
        const left = counts.get(key) || 0;
        if (left > 0) {
            counts.set(key, left - 1);
            continue;
        }
        fresh.push(violation);
    }
    return fresh;
}

function workspaceRoot(filePath) {
    let dir = path.dirname(filePath);
    for (let i = 0; i < 32; i++) {
        if (fs.existsSync(path.join(dir, 'libs', 'theme')) || fs.existsSync(path.join(dir, '.git'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
    return null;
}

function relativeTo(root, filePath) {
    return path.relative(root, filePath).split(path.sep).join('/');
}

function formatViolations(relative, violations) {
    const shown = violations.slice(0, 12).map(violation => {
        const at = violation.line ? `${relative}:${violation.line}` : relative;
        return `  - ${at} ${violation.what}\n    use: ${violation.use}`;
    });
    if (violations.length > 12) shown.push(`  … and ${violations.length - 12} more`);
    return shown.join('\n');
}

function walk(dir, found = []) {
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return found;
    }
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === 'target' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, found);
        else found.push(full);
    }
    return found;
}

function scan(root, targets) {
    const files = targets.flatMap(target => {
        const full = path.resolve(root, target);
        try {
            return fs.statSync(full).isDirectory() ? walk(full) : [full];
        } catch {
            return [];
        }
    });
    return files
        .filter(file => SCANNED_EXTENSIONS.has(path.extname(file)))
        .sort()
        .map(file => {
            const relative = relativeTo(root, file);
            return { relative, violations: designViolations(relative, fs.readFileSync(file, 'utf8'), root) };
        });
}

function cli(argv) {
    const [rootArg, ...targets] = argv;
    if (!rootArg) {
        process.stderr.write('usage: qol-design-guard.cjs <workspace-root> [path ...]\n');
        return 2;
    }
    const root = path.resolve(rootArg);
    const report = scan(root, targets.length ? targets : ['libs/gpui/src', 'apps/tray/src', 'apps/tray/ui', 'plugins']);
    let flagged = 0;
    for (const { relative, violations } of report) {
        if (violations.length === 0) continue;
        flagged++;
        process.stdout.write(`FLAG ${relative} (${violations.length})\n${formatViolations(relative, violations)}\n`);
    }
    process.stdout.write(`${report.length} files scanned, ${report.length - flagged} pass, ${flagged} flagged\n`);
    return flagged ? 1 : 0;
}

module.exports = { designViolations, newViolations, workspaceRoot, relativeTo, formatViolations, scan };

if (require.main === module) process.exit(cli(process.argv.slice(2)));
