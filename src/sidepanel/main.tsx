import "./styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { setupStorageSync } from "./storage-sync";

const qc = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

// Module-scope registration: bridge chrome.storage.onChanged to TanStack Query
// invalidation for settings (sync) and subscriptions (local). Module scope is
// required because <React.StrictMode> double-mounts effects and would
// double-register listeners if this ran inside useEffect.
setupStorageSync(qc);

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Sidepanel root element was not found");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
