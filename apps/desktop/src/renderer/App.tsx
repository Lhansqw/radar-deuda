export function App() {
  const v = window.radar.versions;
  return (
    <main className="splash">
      <h1>Radar de Deuda Técnica</h1>
      <p>
        Electron {v.electron} · Chromium {v.chrome} · Node {v.node}
      </p>
    </main>
  );
}
