const app = document.querySelector<HTMLElement>("#app");

if (!app) {
  throw new Error("Missing app root");
}

app.innerHTML = `
  <section>
    <h1>Heimdall</h1>
    <p>Code review dashboard shell</p>
  </section>
`;
