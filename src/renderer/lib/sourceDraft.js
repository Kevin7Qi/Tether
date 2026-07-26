export function pendingSourceDraftDecision(
  pendingMarkdown,
  modelMarkdown,
  hasSourceControl
) {
  if (typeof pendingMarkdown !== "string") {
    return { suppressModelUpdate: false, settled: false };
  }
  if (hasSourceControl || modelMarkdown !== pendingMarkdown) {
    return { suppressModelUpdate: true, settled: false };
  }
  return { suppressModelUpdate: false, settled: true };
}
