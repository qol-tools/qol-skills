'use strict';

const serde = require('./rust-serde.cjs');

const EVENT_ENUMS = new Set(['RuntimeEventKind', 'RuntimeEvent']);
const PAYLOAD_ENUM = 'RuntimeEvent';
const REGULAR_PAST = /(?:ed|en|wn)$/;
const IRREGULAR_PAST = new Set([
    'Begun', 'Bound', 'Brought', 'Built', 'Caught', 'Cut', 'Done', 'Found', 'Held', 'Kept', 'Laid', 'Left',
    'Lost', 'Made', 'Paid', 'Put', 'Quit', 'Read', 'Run', 'Sent', 'Set', 'Shut', 'Sold', 'Split', 'Spent',
    'Stuck', 'Told', 'Won',
]);

function lexed(file, content) {
    if (!content) return null;
    const source = serde.production(file, content);
    return { source, enums: eventEnums(file, source) };
}

function eventEnums(file, source) {
    const enums = new Map();
    for (const def of serde.fileItems(file, source).defs) {
        if (def.kind === 'enum' && EVENT_ENUMS.has(def.name) && !enums.has(def.name)) enums.set(def.name, def);
    }
    return enums;
}

function lineAt(skeleton, index) {
    return skeleton.slice(0, index).split('\n').length;
}

function enumStart(skeleton, name) {
    const match = new RegExp(`\\benum\\s+${name}\\b`).exec(skeleton);
    return match ? match.index : 0;
}

function variantStart(skeleton, enumName, variant) {
    const from = enumStart(skeleton, enumName);
    const match = new RegExp(`\\b${variant}\\b`).exec(skeleton.slice(from));
    return match ? from + match.index : from;
}

function fieldLine(skeleton, enumName, variant, field) {
    const from = variantStart(skeleton, enumName, variant);
    const match = new RegExp(`\\b${field}\\s*:`).exec(skeleton.slice(from));
    return lineAt(skeleton, match ? from + match.index : from);
}

function isPastTense(name) {
    const word = /[A-Z][a-z0-9]*$/.exec(name)?.[0] ?? name;
    return REGULAR_PAST.test(word) || IRREGULAR_PAST.has(word);
}

function toleratesMissing(field) {
    return field.defaulted || field.skip || field.type?.name === 'Option';
}

function namingViolations(after) {
    const found = [];
    for (const [name, def] of after.enums) {
        for (const variant of def.variants) {
            if (isPastTense(variant.rust)) continue;
            found.push({
                rule: 'name',
                line: lineAt(after.source.skeleton, variantStart(after.source.skeleton, name, variant.rust)),
                text: `${name}::${variant.rust} is not past tense; name the event for what happened (FocusChanged, LauncherAppsSynced)`,
            });
        }
    }
    return found;
}

function shapeViolations(before, after) {
    const found = [];
    for (const [name, base] of before.enums) {
        const now = after.enums.get(name);
        if (!now) continue;
        const variants = new Map(now.variants.map(variant => [variant.rust, variant]));
        for (const old of base.variants) {
            const current = variants.get(old.rust);
            if (!current) {
                found.push({
                    rule: 'removed',
                    line: lineAt(after.source.skeleton, enumStart(after.source.skeleton, name)),
                    text: `${name}::${old.rust} was removed or renamed; subscribers built against it stop parsing. Keep the variant and add a new one`,
                });
                continue;
            }
            if (name !== PAYLOAD_ENUM) continue;
            const oldFields = new Set((old.fields ?? []).map(field => field.rust));
            const newFields = new Set((current.fields ?? []).map(field => field.rust));
            for (const field of oldFields) {
                if (newFields.has(field)) continue;
                found.push({
                    rule: 'removed',
                    line: lineAt(after.source.skeleton, variantStart(after.source.skeleton, name, old.rust)),
                    text: `${name}::${old.rust}.${field} was removed or renamed; payloads are additive only. Keep the field, or add a new variant for the new shape`,
                });
            }
            for (const field of current.fields ?? []) {
                if (oldFields.has(field.rust) || toleratesMissing(field)) continue;
                found.push({
                    rule: 'default',
                    line: fieldLine(after.source.skeleton, name, current.rust, field.rust),
                    text: `${name}::${current.rust}.${field.rust} is a new field without #[serde(default)]; events from an older sender lack it and fail to parse. Add #[serde(default)] or make it an Option`,
                });
            }
        }
    }
    return found;
}

function newViolations(file, baseline, content) {
    const after = lexed(file, content);
    if (!after || after.enums.size === 0) return [];
    const before = lexed(file, baseline) ?? { enums: new Map() };
    return [...namingViolations(after), ...shapeViolations(before, after)].sort((a, b) => a.line - b.line);
}

function formatViolations(violations) {
    return violations.map(violation => `  line ${violation.line}: ${violation.text}`).join('\n');
}

module.exports = { newViolations, formatViolations, isPastTense };
