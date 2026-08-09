import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { appBasePath } from "./basePath";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename={appBasePath || undefined}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
