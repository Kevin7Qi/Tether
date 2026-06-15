# Tether Sample

This sample document is for checking local rendering quality before connecting to a remote Markdown file.

Inline code such as `remotePath`, `~/.ssh/config`, and `provider.readFile()` should sit comfortably inside a sentence.

## Headings And Lists

- Remote files are opened over SSH/SFTP.
- Polling checks remote metadata and reloads changed content.
- The last successful render remains visible if a refresh fails.

### Task List

- [x] GitHub-flavored Markdown
- [x] Tables
- [x] Fenced code blocks
- [x] Inline and block math
- [x] Your remote documentationx

## Table

| Area | Prototype behavior | Notes |
| --- | --- | --- |
| Authentication | Password or private key path | Secrets stay in memory only |
| Watching | SFTP stat/read polling | No SSHFS or mounted folders |
| Editing | Source pane plus conflict check | No WYSIWYG editor yet |

## Code

Use `npm run dev` for local iteration and `npm run build` before shipping a renderer bundle.

```js
async function refreshRemoteFile(provider, path) {
  const metadata = await provider.statFile(path);
  const document = await provider.readFile(path);
  return { metadata, content: document.content };
}
```

## Math

Inline math: $E = mc^2$.

Block math:

$$
f(x) = \sum_{n=0}^{\infty} \frac{f^{(n)}(0)}{n!}x^n
$$
