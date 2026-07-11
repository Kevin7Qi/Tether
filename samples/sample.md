# Tether Sample

This sample document is for checking local rendering quality before connecting to a remote Markdown file.

Inline code such as `remotePath`, `~/.ssh/config`, and `provider.readFile()` should sit comfortably inside a sentence.

Rendered **bold text**, *italic text*, ~~strikethrough~~, [links](https://example.com), and $E = mc^2$ should share one calm baseline and reveal their Markdown source when edited.

## Headings And Lists

- Remote files are opened over SSH/SFTP.
- Polling checks remote metadata and reloads changed content.
- The last successful render remains visible if a refresh fails.
  - Nested items should stay close to their parent.
  - A second nested item checks the list rhythm.

### Task List

- [x] GitHub-flavored Markdown
- [x] Tables
- [x] Fenced code blocks
- [x] Inline and block math
- [x] Your remote documentation
- [ ] A remaining task keeps a clear unchecked state

> A blockquote should feel related to the surrounding paragraph without becoming a large padded card. It can contain **emphasis** and `inline code` without disturbing the line rhythm.

## Table

| Area | Prototype behavior | Notes |
| --- | --- | --- |
| Auth | Password or private key path | Secrets stay in memory only |
| Watching | SFTP metadata polling and conditional reloads | No SSHFS or mounted folders are required |
| Editing | A continuous inline document with a source fallback | Markdown remains portable and directly editable |

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
