import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { OptionsApp } from "./OptionsApp";
import { setupStorageSync } from "./storage-sync";
import "../sidepanel/styles.css";
import "./options.css";

const qc = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

// Module-scope registration: bridge chrome.storage.onChanged to TanStack Query
// invalidation. Must run at module scope, not in useEffect, because
// <React.StrictMode> double-mounts effects.
setupStorageSync(qc);

const root = document.getElementById("root");

if (!root) {
  throw new Error("Options root element not found");
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <OptionsApp />
    </QueryClientProvider>
  </React.StrictMode>,
);
