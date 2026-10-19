// Entrada y salida con GitHub a través de `gh`, que viene instalado en los
// runners. Las funciones de entrega reciben estas operaciones como parámetros, y
// los tests les pasan una API simulada.
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";

export function conexion(token) {
  if (!token) throw new Error("Falta el token de GitHub.");
  const env = { ...process.env, GH_TOKEN: token, GH_PROMPT_DISABLED: "1" };

  function gh(args, { input, salida } = {}) {
    if (salida) {
      const fd = openSync(salida, "w");
      try {
        const r = spawnSync("gh", args, { env, stdio: ["ignore", fd, "pipe"], encoding: "utf8" });
        if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")}: ${r.stderr.trim()}`);
      } finally { closeSync(fd); }
      return null;
    }
    return execFileSync("gh", args, { env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  }

  /** JSON de la API REST. Un 404 devuelve null; cualquier otro error lanza. */
  async function api(ruta, metodo = "GET", cuerpo) {
    const args = ["api", ruta, "--method", metodo, "-H", "Accept: application/vnd.github+json"];
    if (cuerpo !== undefined) args.push("--input", "-");
    try {
      const salida = gh(args, { input: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
      return salida.trim() ? JSON.parse(salida) : null;
    } catch (error) {
      if (metodo === "GET" && /HTTP 404/.test(String(error.stderr ?? error.message))) return null;
      throw new Error(`${metodo} ${ruta}: ${String(error.stderr ?? error.message).trim()}`);
    }
  }

  /** Todas las páginas de un listado. `clave` es el campo que trae la lista, si no es la raíz. */
  async function todas(ruta, clave) {
    const elementos = [];
    for (let pagina = 1; ; pagina++) {
      const sep = ruta.includes("?") ? "&" : "?";
      const r = await api(`${ruta}${sep}per_page=100&page=${pagina}`);
      const lista = clave ? r?.[clave] ?? [] : r ?? [];
      elementos.push(...lista);
      if (lista.length < 100) return elementos;
    }
  }

  /** Descarga binaria (artefactos, assets): `gh api` sigue la redirección sin reenviar el token. */
  async function descargar(ruta, destino, accept = "application/octet-stream") {
    gh(["api", ruta, "-H", `Accept: ${accept}`], { salida: destino });
  }

  async function subir(repo, tag, rutas) {
    gh(["release", "upload", tag, "--repo", repo, ...rutas]);
  }

  return { api, todas, descargar, subir };
}
