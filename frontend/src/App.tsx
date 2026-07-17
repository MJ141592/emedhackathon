import { useEffect, useState } from "react";

type HealthResponse = {
  status: string;
  service: string;
};

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/health", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Backend health check failed");
        return response.json() as Promise<HealthResponse>;
      })
      .then(setHealth)
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setError(true);
      });

    return () => controller.abort();
  }, []);

  return (
    <main>
      <section aria-labelledby="page-title">
        <p className="eyebrow">eMed Hackathon</p>
        <h1 id="page-title">Full-stack workspace ready.</h1>
        <p className="summary">
          React and TypeScript are connected to a Python FastAPI backend.
        </p>
        <div className="status" role="status">
          <span className={error ? "status-dot error" : "status-dot"} aria-hidden="true" />
          {error
            ? "Backend unavailable"
            : health
              ? `${health.service} is ${health.status}`
              : "Checking backend connection"}
        </div>
      </section>
    </main>
  );
}

export default App;

