// Verifica un candidato del repo privado ANTES de que nada se publique: que el run
// es el workflow del candidato, sobre la rama de release, completo y en verde; que
// el tag anotado señala ese commit y ancla el paquete; y que el paquete descargado
// es, byte a byte, el que el candidato dejó. Solo lee: ni publica ni modifica nada.
//
// Lo ejecuta el job `verificar` de `piloto.yml` con el secreto
// DOWNLOADS_6KEYS_READ_ONLY: el token «6Keys downloads (read-only)»,
// de solo lectura (Actions y Contents del repo privado, nada más).
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  JOBS_DEL_CANDIDATO, MANIFIESTO, ORIGEN, WORKFLOW_CANDIDATO, comprobarManifiesto, comprobarYml,
  leerAnclaDelTag, sha256, sha256DeFichero, sha512DeFichero, tagDelPaquete, versionEstable
} from "./reglas.mjs";

function exigir(condicion, mensaje) {
  if (!condicion) throw new Error(mensaje);
}

export async function verificarCandidato({ destino, version, runId, ensayo, dir, api, todas, descargar, extraer }) {
  const v = versionEstable(version);
  exigir(Number.isSafeInteger(runId) && runId > 0, `run_id no válido: ${runId}`);
  const tag = tagDelPaquete({ version: v.texto, ensayo, runId });

  // 1. El run: el workflow del candidato, a mano, terminado y en verde.
  const run = await api(`repos/${ORIGEN}/actions/runs/${runId}`);
  exigir(run, `No existe el run ${runId} en ${ORIGEN}.`);
  exigir(run.path === WORKFLOW_CANDIDATO, `El run ${runId} es de ${run.path}, no de ${WORKFLOW_CANDIDATO}.`);
  exigir(run.event === "workflow_dispatch", `El run ${runId} lo lanzó «${run.event}», no un dispatch.`);
  exigir(run.repository?.full_name === ORIGEN && run.head_repository?.full_name === ORIGEN, "El run no es del repo de 6Keys.");
  exigir(run.status === "completed" && run.conclusion === "success", `El run ${runId} no terminó en verde (${run.status}/${run.conclusion}).`);
  exigir(/^[a-f0-9]{40}$/.test(run.head_sha ?? ""), "El run no trae un SHA válido.");
  if (!ensayo) exigir(run.head_branch === v.rama, `Un candidato de ${v.texto} sale de ${v.rama}, y este run es de «${run.head_branch}».`);

  // 2. El ensayo COMPLETO, no solo que exista el artefacto: cada job obligatorio
  // presente y en verde en su ÚLTIMA ejecución. Se piden todos los intentos y se
  // reconstruye a mano, job a job: tras «Re-run failed jobs» la API no garantiza
  // que la lista del último intento traiga también los que no se repitieron.
  const ejecuciones = await todas(`repos/${ORIGEN}/actions/runs/${runId}/jobs?filter=all`, "jobs");
  const ultima = new Map();
  for (const j of ejecuciones) {
    const previa = ultima.get(j.name);
    if (!previa || j.run_attempt > previa.run_attempt || (j.run_attempt === previa.run_attempt && j.id > previa.id)) ultima.set(j.name, j);
  }
  const jobs = [...ultima.values()];
  for (const nombre of JOBS_DEL_CANDIDATO) {
    exigir(ultima.has(nombre), `Falta el job «${nombre}» en el run ${runId}: el ensayo no está completo.`);
  }
  const noVerdes = jobs.filter(j => j.conclusion !== "success");
  exigir(noVerdes.length === 0, `Jobs que no están en verde en su última ejecución: ${noVerdes.map(j => `${j.name} (${j.conclusion})`).join(", ")}`);
  // `paquete` recoge lo que dejan los demás: tiene que ser posterior (o del mismo
  // intento) que todo lo que lo alimenta, y `candidato`, posterior a él.
  const paquete = ultima.get("paquete");
  const tardios = jobs.filter(j => !["paquete", "candidato"].includes(j.name) && j.run_attempt > paquete.run_attempt);
  exigir(tardios.length === 0, `El paquete es del intento ${paquete.run_attempt} y ${tardios.map(j => j.name).join(", ")} de uno posterior: no recoge lo último.`);
  exigir(ultima.get("candidato").run_attempt >= paquete.run_attempt, "El agregado «candidato» es anterior al paquete.");

  // 3. El commit: árbol, versión del package.json y pertenencia a la rama de release.
  const commit = await api(`repos/${ORIGEN}/git/commits/${run.head_sha}`);
  exigir(commit?.tree?.sha, `No se pudo leer el commit ${run.head_sha}.`);
  const pkg = await api(`repos/${ORIGEN}/contents/package.json?ref=${run.head_sha}`);
  const declarada = JSON.parse(Buffer.from(pkg?.content ?? "", "base64").toString("utf8") || "{}").version;
  exigir(declarada === v.texto, `El package.json de ${run.head_sha.slice(0, 7)} dice ${declarada}, no ${v.texto}.`);
  if (!ensayo) {
    const cmp = await api(`repos/${ORIGEN}/compare/${run.head_sha}...${encodeURIComponent(v.rama)}`);
    exigir(["ahead", "identical"].includes(cmp?.status), `${run.head_sha.slice(0, 7)} no está en ${v.rama} (${cmp?.status}).`);
  }

  // 4. El ancla: el tag anotado vX.Y.Z señala este commit y guarda las huellas.
  let ancla = null;
  if (!ensayo) {
    const ref = await api(`repos/${ORIGEN}/git/ref/tags/${v.tag}`);
    exigir(ref, `Falta el tag ${v.tag} en ${ORIGEN}: lo crea el candidato al terminar en verde.`);
    exigir(ref.object?.type === "tag", `${v.tag} no es un tag anotado: no lo creó el candidato.`);
    const anotado = await api(`repos/${ORIGEN}/git/tags/${ref.object.sha}`);
    exigir(anotado?.object?.type === "commit" && anotado.object.sha === run.head_sha,
      `${v.tag} señala ${anotado?.object?.sha?.slice(0, 7)}, no el commit del candidato ${run.head_sha.slice(0, 7)}.`);
    ancla = leerAnclaDelTag(anotado.message);
    exigir(ancla.run_id === runId, `El tag ${v.tag} es del run ${ancla.run_id}, no del ${runId}.`);
  }

  // 5. El artefacto: uno solo con ese nombre, con digest, y el descargado coincide.
  const artefactos = await todas(`repos/${ORIGEN}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(`entrega-${tag}`)}`, "artifacts");
  exigir(artefactos.length === 1, `Se esperaba un artefacto entrega-${tag} y hay ${artefactos.length}.`);
  const artefacto = artefactos[0];
  exigir(!artefacto.expired, ensayo
    ? `El artefacto entrega-${tag} ha caducado: lanza otro ensayo.`
    : `El artefacto entrega-${tag} ha caducado. El tag ${tag} ya existe y no se reutiliza: sube el parche y lanza otro candidato.`);
  exigir(/^sha256:[a-f0-9]{64}$/.test(artefacto.digest ?? ""), "El artefacto no trae digest: no se puede comprobar.");
  if (ancla) {
    exigir(artefacto.id === ancla.artefacto_id && artefacto.digest === ancla.artefacto_digest,
      "El artefacto no es el que anotó el tag.");
  }
  mkdirSync(dir, { recursive: true });
  const zip = join(dir, "paquete.zip");
  // El zip de un artefacto se pide con el Accept normal de la API (redirige al
  // fichero); `application/octet-stream` da 415 aquí y solo vale para los assets
  // de una release. Visto contra un run real el 2026-10-19.
  await descargar(`repos/${ORIGEN}/actions/artifacts/${artefacto.id}/zip`, zip, "application/vnd.github+json");
  exigir(`sha256:${await sha256DeFichero(zip)}` === artefacto.digest, "El zip descargado no coincide con el digest del artefacto.");
  const carpeta = join(dir, "paquete");
  await extraer(zip, carpeta);

  // 6. El manifiesto y cada fichero.
  const bytes = readFileSync(join(carpeta, MANIFIESTO));
  const manifiestoSha256 = sha256(bytes);
  if (ancla) exigir(manifiestoSha256 === ancla.manifiesto_sha256, "El manifiesto no es el que anotó el tag.");
  const manifiesto = comprobarManifiesto(JSON.parse(bytes), { version: v.texto, tag, ensayo, sha: run.head_sha });
  const p = manifiesto.procedencia;
  exigir(p.run_id === runId && p.rama === run.head_branch && p.arbol === commit.tree.sha,
    "La procedencia del manifiesto no coincide con el run.");
  exigir(p.run_attempt === paquete.run_attempt && p.run_attempt <= run.run_attempt,
    `El manifiesto es del intento ${p.run_attempt} y el job «paquete» que vale es del ${paquete.run_attempt}.`);
  const enCarpeta = readdirSync(carpeta).filter(n => n !== MANIFIESTO).sort();
  exigir(JSON.stringify(enCarpeta) === JSON.stringify(manifiesto.files.map(f => f.name).sort()),
    "El paquete trae ficheros distintos de los del manifiesto.");
  for (const f of manifiesto.files) {
    const ruta = join(carpeta, f.name);
    exigir(statSync(ruta).isFile() && statSync(ruta).size === f.size, `Tamaño distinto: ${f.name}`);
    exigir(await sha256DeFichero(ruta) === f.sha256, `Huella distinta: ${f.name}`);
  }
  // Los manifiestos del actualizador: solo direcciones de su tag, y la huella
  // SHA-512 y el tamaño que anuncian son los de los ficheros reales (es lo que el
  // actualizador comprobará en cada instalación).
  for (const nombre of manifiesto.files.map(f => f.name).filter(n => n.endsWith(".yml"))) {
    for (const f of comprobarYml(readFileSync(join(carpeta, nombre), "utf8"), { version: v.texto, destino, tag, nombre })) {
      const ruta = join(carpeta, f.nombre);
      exigir(statSync(ruta).size === f.size, `${nombre} anuncia otro tamaño para ${f.nombre}.`);
      exigir(await sha512DeFichero(ruta) === f.sha512, `${nombre} anuncia otra huella SHA-512 para ${f.nombre}.`);
    }
  }

  return {
    carpeta, tag, version: v.texto, ensayo: Boolean(ensayo), manifiestoSha256,
    procedencia: {
      repositorio: ORIGEN, run_id: runId, run_attempt: run.run_attempt, paquete_attempt: p.run_attempt,
      rama: run.head_branch, sha: run.head_sha, arbol: commit.tree.sha,
      artefacto_id: artefacto.id, artefacto_digest: artefacto.digest, manifiesto_sha256: manifiestoSha256,
      ...(p.instalada ? { instalada: p.instalada } : {})
    }
  };
}

export function resumen(r) {
  const p = r.procedencia;
  return [
    `## ${r.ensayo ? "Ensayo" : "Candidato"} ${r.tag} verificado`, "",
    "| | |", "|---|---|",
    `| Versión | ${r.version} |`,
    `| Commit | \`${p.sha}\` (${p.rama}) |`,
    `| Árbol | \`${p.arbol}\` |`,
    `| Run del candidato | ${p.run_id}, intento ${p.run_attempt} (paquete del intento ${p.paquete_attempt}) |`,
    `| Actualización ensayada | desde v${p.instalada ?? "?"} |`,
    `| Artefacto | ${p.artefacto_id}, \`${p.artefacto_digest}\` |`,
    `| release-manifest.json | \`sha256:${p.manifiesto_sha256}\` |`, ""
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { conexion } = await import("./gh.mjs");
  const { api, todas, descargar } = conexion(process.env.GH_TOKEN);
  const salida = resolve(process.env.SALIDA ?? "verificado");
  // «auto» (modo verificar): el run dice si trae un paquete de ensayo o nominado.
  let ensayo = process.env.ENSAYO === "true";
  if (process.env.ENSAYO === "auto") {
    const runId = Number(process.env.RUN_ID);
    ensayo = (await todas(`repos/${ORIGEN}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(`entrega-ensayo-${runId}`)}`, "artifacts")).length > 0;
    console.log(`Modo verificar: el run ${runId} trae un paquete ${ensayo ? "de ensayo" : "nominado"}.`);
  }
  const r = await verificarCandidato({
    destino: process.env.GITHUB_REPOSITORY, version: process.env.VERSION, runId: Number(process.env.RUN_ID),
    ensayo, dir: salida, api, todas, descargar,
    // `unzip` viene en los runners de Ubuntu y se niega a escribir fuera de la carpeta.
    extraer: async (zip, carpeta) => { execFileSync("unzip", ["-q", "-o", zip, "-d", carpeta], { stdio: "inherit" }); }
  });
  appendFileSync(process.env.GITHUB_STEP_SUMMARY ?? "/dev/null", resumen(r));
  appendFileSync(process.env.GITHUB_OUTPUT ?? "/dev/null", `tag=${r.tag}\nmanifiesto_sha256=${r.manifiestoSha256}\nprocedencia=${JSON.stringify(r.procedencia)}\n`);
  console.log(resumen(r));
}
