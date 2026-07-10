import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

const rootElement = document.getElementById("root");
const reactRoot = window.__TETHER_REACT_ROOT__ || createRoot(rootElement);
window.__TETHER_REACT_ROOT__ = reactRoot;
reactRoot.render(<App />);
