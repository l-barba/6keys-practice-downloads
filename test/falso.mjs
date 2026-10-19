// Un GitHub de mentira para los tests: el repo privado con su run de candidato y
// el repo de descargas con sus releases. Nada sale a la red.
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JOBS_DEL_CANDIDATO, MANIFIESTO, ORIGEN, WORKFLOW_CANDIDATO, ficherosDeLaVersion, sha256, tagDelPaquete
} from "../entrega/reglas.mjs";

export const DESTINO = "l-barba/6keys-practice-downloads";
export const SHA = "c".repeat(40);
export const ARBOL = "d".repeat(40);
export const RUN = 4242;

export async function carpetaTemporal(t) {
  const dir = await mkdtemp(join(tmpdir(), "entrega-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Lo que deja `paquete` en el candidato: ficheros, yml con URLs permanentes y manifiesto v2. */
export function paquete(dir, { version = "0.5.0", ensayo = false, runId = RUN, sha = SHA, rama = "release/0.5", attempt = 1 } = {}) {
  const tag = tagDelPaquete({ version, ensayo, runId });
  const base = `https://github.com/${DESTINO}/releases/download/${tag}/`;
  mkdirSync(dir, { recursive: true });
  const contenidos = new Map(ficherosDeLaVersion(version).filter(n => !n.endsWith(".yml")).map(n => [n, `binario ${n}`]));
  const sha512 = n => createHash("sha512").update(contenidos.get(n)).digest("base64");
  for (const [nombre, arch, exts] of [["latest-x64.yml", "x64", ["exe"]], ["latest-x64-mac.yml", "x64", ["zip", "dmg"]], ["latest-arm64-mac.yml", "arm64", ["zip", "dmg"]]]) {
    // Como lo deja `preparar-paquete` (js-yaml): valores largos plegados con `>-`.
    const instaladores = exts.map(ext => `6Keys-Practice-${version}-${arch}.${ext}`);
    const lineas = [`version: ${version}`, "files:"];
    for (const n of instaladores) lineas.push("  - url: >-", `      ${base}${n}`, "    sha512: >-", `      ${sha512(n)}`, `    size: ${Buffer.byteLength(contenidos.get(n))}`);
    lineas.push("path: >-", `  ${base}${instaladores[0]}`, "sha512: >-", `  ${sha512(instaladores[0])}`, "releaseDate: '2026-10-19T10:00:00.000Z'", "");
    contenidos.set(nombre, lineas.join("\n"));
  }
  const files = [];
  for (const [nombre, contenido] of contenidos) {
    writeFileSync(join(dir, nombre), contenido);
    files.push({ name: nombre, size: Buffer.byteLength(contenido), sha256: sha256(contenido) });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  const manifiesto = {
    schema: 2, tag, version, ensayo, commit: sha,
    procedencia: { repositorio: ORIGEN, workflow: WORKFLOW_CANDIDATO, run_id: runId, run_attempt: attempt, rama, arbol: ARBOL, instalada: "0.4.1" },
    files
  };
  const bytes = JSON.stringify(manifiesto, null, 2) + "\n";
  writeFileSync(join(dir, MANIFIESTO), bytes);
  return { tag, manifiestoSha256: sha256(bytes), manifiesto };
}

/** El repo privado visto por la API, con un candidato en verde. `cambios` lo estropea a voluntad. */
export function origen({ version = "0.5.0", ensayo = false, carpetaPaquete, manifiestoSha256, cambios = {} }) {
  const tag = tagDelPaquete({ version, ensayo, runId: RUN });
  const zip = Buffer.from(`zip de ${tag}`);
  const estado = {
    run: {
      id: RUN, path: WORKFLOW_CANDIDATO, event: "workflow_dispatch", status: "completed", conclusion: "success",
      head_branch: ensayo ? "main" : "release/0.5", head_sha: SHA, run_attempt: 1,
      repository: { full_name: ORIGEN }, head_repository: { full_name: ORIGEN }
    },
    jobs: JOBS_DEL_CANDIDATO.map(n => ({ name: n, conclusion: "success", run_attempt: 1 })),
    version,
    tagRef: ensayo ? null : { object: { type: "tag", sha: "e".repeat(40) } },
    tagAnotado: null,
    artefactos: [{ id: 77, name: `entrega-${tag}`, expired: false, digest: `sha256:${sha256(zip)}` }],
    zip, compare: "ahead"
  };
  estado.tagAnotado = {
    object: { type: "commit", sha: SHA },
    message: `6Keys Practice ${version}\n\nsixkeys-candidato: ${JSON.stringify({ run_id: RUN, manifiesto_sha256: manifiestoSha256, artefacto_id: 77, artefacto_digest: estado.artefactos[0].digest })}\n`
  };
  Object.assign(estado, typeof cambios === "function" ? cambios(estado) ?? {} : cambios);

  const api = async ruta => {
    if (ruta === `repos/${ORIGEN}/actions/runs/${RUN}`) return estado.run;
    if (ruta === `repos/${ORIGEN}/git/commits/${SHA}`) return { tree: { sha: ARBOL } };
    if (ruta === `repos/${ORIGEN}/contents/package.json?ref=${SHA}`) return { content: Buffer.from(JSON.stringify({ version: estado.version })).toString("base64") };
    if (ruta.startsWith(`repos/${ORIGEN}/compare/`)) return { status: estado.compare };
    if (ruta.startsWith(`repos/${ORIGEN}/git/ref/tags/`)) return estado.tagRef;
    if (ruta === `repos/${ORIGEN}/git/tags/${"e".repeat(40)}`) return estado.tagAnotado;
    if (ruta.startsWith(`repos/${ORIGEN}/actions/runs/${RUN}`)) return null;
    throw new Error(`Ruta no esperada: ${ruta}`);
  };
  const todas = async (ruta, clave) => {
    if (ruta.startsWith(`repos/${ORIGEN}/actions/runs/${RUN}/jobs`)) return estado.jobs;
    if (ruta.startsWith(`repos/${ORIGEN}/actions/runs/${RUN}/artifacts`)) {
      const nombre = decodeURIComponent(/name=([^&]+)/.exec(ruta)[1]);
      return estado.artefactos.filter(a => a.name === nombre);
    }
    throw new Error(`Listado no esperado: ${ruta} (${clave})`);
  };
  const descargar = async (ruta, destino, accept) => {
    // Como GitHub: el zip de un artefacto no admite octet-stream (HTTP 415).
    if (accept === "application/octet-stream" || accept === undefined) throw new Error("gh: Unsupported 'Accept' header (HTTP 415)");
    writeFileSync(destino, estado.zip);
  };
  const extraer = async (zip, carpeta) => { cpSync(carpetaPaquete, carpeta, { recursive: true }); };
  return { estado, api, todas, descargar, extraer };
}

/** El repo de descargas: releases con sus assets, subidas, PATCH y DELETE. */
export function descargas({ releases = [], latest = null } = {}) {
  let siguienteId = 1000;
  const estado = { releases: releases.map(r => ({ assets: [], body: "", ...r })), latest, llamadas: [] };
  const buscar = id => estado.releases.find(r => r.id === Number(id));
  const conAssets = r => ({ ...r, assets: r.assets.map(({ datos, ...a }) => a) });

  const api = async (ruta, metodo = "GET", cuerpo) => {
    estado.llamadas.push([metodo, ruta, cuerpo]);
    let m;
    if (ruta === `repos/${DESTINO}`) return { private: false, default_branch: "development" };
    if (ruta === `repos/${DESTINO}/releases/latest`) {
      const tag = estado.latest ?? null;
      const r = estado.releases.find(x => x.tag_name === tag);
      return r ? conAssets(r) : null;
    }
    if ((m = /^repos\/[^/]+\/[^/]+\/releases\/tags\/(.+)$/.exec(ruta))) {
      const r = estado.releases.find(x => x.tag_name === m[1] && !x.draft);
      return r ? conAssets(r) : null;
    }
    if (ruta === `repos/${DESTINO}/releases` && metodo === "POST") {
      const r = { id: siguienteId++, assets: [], immutable: false, published_at: null, html_url: "https://github.com/x/release", ...cuerpo };
      estado.releases.push(r);
      return conAssets(r);
    }
    if ((m = /^repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)$/.exec(ruta)) && metodo === "DELETE") {
      for (const r of estado.releases) r.assets = r.assets.filter(a => a.id !== Number(m[1]));
      return null;
    }
    if ((m = /^repos\/[^/]+\/[^/]+\/releases\/(\d+)$/.exec(ruta))) {
      const r = buscar(m[1]);
      if (metodo === "DELETE") { estado.releases = estado.releases.filter(x => x !== r); return null; }
      if (metodo === "PATCH") {
        Object.assign(r, cuerpo);
        if (cuerpo.draft === false && !r.published_at) { r.published_at = "2026-10-19T09:00:00Z"; r.immutable = true; }
        if (cuerpo.make_latest === "true") estado.latest = r.tag_name;
        return conAssets(r);
      }
      return conAssets(r);
    }
    throw new Error(`Ruta no esperada: ${metodo} ${ruta}`);
  };
  const todas = async ruta => {
    let m;
    if (ruta === `repos/${DESTINO}/releases`) return estado.releases.map(conAssets);
    if ((m = /^repos\/[^/]+\/[^/]+\/releases\/(\d+)\/assets$/.exec(ruta))) return buscar(m[1]).assets.map(({ datos, ...a }) => a);
    throw new Error(`Listado no esperado: ${ruta}`);
  };
  const subir = async (repo, tag, rutas) => {
    const r = estado.releases.find(x => x.tag_name === tag && x.draft);
    for (const ruta of rutas) {
      const datos = readFileSync(ruta);
      const name = ruta.split("/").pop();
      r.assets.push({ id: siguienteId++, name, size: datos.length, updated_at: "t", digest: `sha256:${sha256(datos)}`, datos });
    }
  };
  const descargar = async (ruta, destino) => {
    const id = Number(/assets\/(\d+)$/.exec(ruta)[1]);
    const a = estado.releases.flatMap(r => r.assets).find(x => x.id === id);
    writeFileSync(destino, a.datos);
  };
  return { estado, api, todas, subir, descargar };
}

/** Una release publicada con los assets de un paquete (para promocionar). */
export function releaseDesdePaquete(carpeta, manifiesto, extra) {
  const assets = [...manifiesto.files.map(f => f.name), MANIFIESTO].map((name, i) => {
    const datos = readFileSync(join(carpeta, name));
    return { id: 500 + i, name, size: datos.length, updated_at: "t", digest: `sha256:${sha256(datos)}`, datos };
  });
  return { id: 99, draft: false, prerelease: true, immutable: true, published_at: "2026-10-10T09:00:00Z", assets, ...extra };
}
