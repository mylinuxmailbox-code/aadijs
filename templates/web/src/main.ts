export function greet(name: string): string {
  return `Why wait when you can Aadi, ${name}?`;
}

if (typeof document !== "undefined") {
  const el = document.getElementById("app");
  if (el) {
    el.innerHTML = `<main><h1>⚡ AadiJS</h1><p>${greet("Developer")}</p></main>`;
  }
}
