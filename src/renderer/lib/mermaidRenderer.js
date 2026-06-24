const MERMAID_FONT_FAMILY =
  '"Instrument Sans", "Segoe UI Variable", "Segoe UI", ui-sans-serif, system-ui, sans-serif';
const SECURE_CONFIG_KEYS = [
  "securityLevel",
  "startOnLoad",
  "secure",
  "theme",
  "themeCSS",
  "themeVariables",
  "fontFamily",
  "htmlLabels",
  "flowchart",
  "sequence",
  "gantt",
  "class",
  "state",
  "er",
  "pie"
];

let mermaidModulePromise = null;
let mermaidRenderQueue = Promise.resolve();

export function normalizeMermaidTheme(theme) {
  return theme === "light" ? "light" : "dark";
}

export function normalizeMermaidSource(source) {
  return String(source ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

export function buildMermaidConfig(theme) {
  const normalizedTheme = normalizeMermaidTheme(theme);
  const dark = normalizedTheme === "dark";

  return {
    startOnLoad: false,
    securityLevel: "strict",
    secure: [...SECURE_CONFIG_KEYS],
    theme: dark ? "dark" : "default",
    fontFamily: MERMAID_FONT_FAMILY,
    logLevel: "fatal",
    htmlLabels: false,
    flowchart: {
      htmlLabels: false,
      useMaxWidth: true
    },
    sequence: {
      useMaxWidth: true
    },
    gantt: {
      useMaxWidth: true
    },
    themeVariables: dark
      ? {
          background: "#15181b",
          primaryColor: "#1f262a",
          primaryTextColor: "#dee4e8",
          primaryBorderColor: "#4dbe83",
          lineColor: "#74818c",
          secondaryColor: "#20262b",
          tertiaryColor: "#101316",
          textColor: "#dee4e8",
          fontFamily: MERMAID_FONT_FAMILY
        }
      : {
          background: "#f6f8f8",
          primaryColor: "#e8f0ec",
          primaryTextColor: "#14171a",
          primaryBorderColor: "#1f8754",
          lineColor: "#68727a",
          secondaryColor: "#eef2f1",
          tertiaryColor: "#ffffff",
          textColor: "#14171a",
          fontFamily: MERMAID_FONT_FAMILY
        }
  };
}

export function normalizeMermaidError(error) {
  const rawMessage =
    error?.str ||
    error?.message ||
    (typeof error === "string" ? error : "") ||
    "The diagram source could not be parsed.";
  return String(rawMessage)
    .replace(/\s+/g, " ")
    .replace(/^Error:\s*/i, "")
    .trim()
    .slice(0, 220);
}

export async function renderMermaidDiagram({ id, source, theme }) {
  const diagramSource = normalizeMermaidSource(source);
  if (!diagramSource) {
    throw new Error("The Mermaid diagram is empty.");
  }

  const renderTask = async () => {
    const mermaid = await getMermaidModule();
    mermaid.initialize(buildMermaidConfig(theme));
    const result = await mermaid.render(id, diagramSource);
    return {
      svg: result.svg,
      diagramType: result.diagramType || ""
    };
  };

  const queuedRender = mermaidRenderQueue.then(renderTask, renderTask);
  mermaidRenderQueue = queuedRender.catch(() => {});
  return queuedRender;
}

async function getMermaidModule() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import("mermaid").then((module) => module.default || module);
  }
  return mermaidModulePromise;
}
