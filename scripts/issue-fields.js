// Read fields out of a GitHub issue form body, for the link workflows.
// Usage: BODY=... node scripts/issue-fields.js [--output] NAME="Form label" ...
//
// Each field is the first non-blank line after its "### <label>" header,
// trimmed; a blank optional field arrives as "_No response_" and reads as
// empty. The values are appended to $GITHUB_ENV (or $GITHUB_OUTPUT with
// --output) in the heredoc form, so a value is never interpreted by a shell
// or a template: the workflows then read them as plain environment variables.
// One parser for every workflow, where each used to carry its own.
import fs from 'fs';

export function issueField(body, label) {
    const lines = String(body || '').split(/\r?\n/);
    const i = lines.findIndex(l => l.startsWith(`### ${label}`));
    const value = i < 0 ? '' : (lines.slice(i + 1).find(l => l.trim()) || '').trim();
    return value === '_No response_' ? '' : value;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
    const args = process.argv.slice(2);
    const output = args[0] === '--output';
    const target = process.env[output ? 'GITHUB_OUTPUT' : 'GITHUB_ENV'];
    let text = '';
    for (const spec of output ? args.slice(1) : args) {
        const at = spec.indexOf('=');
        const name = spec.slice(0, at), label = spec.slice(at + 1);
        const value = issueField(process.env.BODY, label);
        // Heredoc form: safe for any value, including quotes and newlines
        const marker = `EOF_${name}_${Date.now()}`;
        text += `${name}<<${marker}\n${value}\n${marker}\n`;
        console.log(`${name}=${value}`);
    }
    if (target) fs.appendFileSync(target, text);
    else process.stdout.write(text);
}
