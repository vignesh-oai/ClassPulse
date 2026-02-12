import { createRoot } from "react-dom/client";
import { useWidgetProps } from "../hooks/use-widget-props";

type SqliteWidgetProps = {
  tool?: string;
  result?: string;
};

function App() {
  const widgetProps = useWidgetProps<SqliteWidgetProps>(() => ({}));

  return (
    <div className="antialiased w-full min-h-[220px] p-4 border border-black/10 rounded-2xl bg-white text-black">
      <h2 className="text-sm font-semibold">SQLite MCP tool</h2>
      <p className="text-sm text-black/70 mt-1">Connected to local sqlite tools.</p>
      {widgetProps.tool ? (
        <p className="text-sm mt-2">Last tool: {widgetProps.tool}</p>
      ) : null}
      {widgetProps.result ? (
        <pre className="mt-3 text-xs overflow-auto bg-black/[0.04] p-2 rounded-lg max-h-44">
          {widgetProps.result}
        </pre>
      ) : null}
    </div>
  );
}

const root = document.getElementById("sqlite-root");
if (root) {
  createRoot(root).render(<App />);
}
