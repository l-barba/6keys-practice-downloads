import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { verificarCandidato } from "../entrega/verificar.mjs";
import { ARBOL, DESTINO, RUN, SHA, carpetaTemporal, origen, paquete } from "./falso.mjs";

async function preparar(t, { ensayo = false, cambios, estropear, anclaDelManifiesto = false } = {}) {
  const dir = await carpetaTemporal(t);
  const carpetaPaquete = join(dir, "origen");
  const p = paquete(carpetaPaquete, { ensayo, rama: ensayo ? "main" : "release/0.5" });
  estropear?.(carpetaPaquete);
  // Con `anclaDelManifiesto`, el tag ancla el manifiesto YA cambiado: así se prueba
  // la comprobación que va detrás, no la del ancla.
  const manifiestoSha256 = anclaDelManifiesto ? createHash("sha256").update(readFileSync(join(carpetaPaquete, "release-manifest.json"))).digest("hex") : p.manifiestoSha256;
  const o = origen({ ensayo, carpetaPaquete, manifiestoSha256, cambios });
  return () => verificarCandidato({ destino: DESTINO, version: "0.5.0", runId: RUN, ensayo, dir: join(dir, "trabajo"), ...o });
}

test("un candidato nominado y completo pasa, con toda su procedencia", async t => {
  const r = await (await preparar(t))();
  assert.equal(r.tag, "v0.5.0");
  assert.equal(r.procedencia.sha, SHA);
  assert.equal(r.procedencia.arbol, ARBOL);
  assert.equal(r.procedencia.artefacto_id, 77);
  assert.match(r.manifiestoSha256, /^[a-f0-9]{64}$/);
});

test("un ensayo pasa sin tag y bajo ensayo-<run>, pero no como candidato real", async t => {
  const r = await (await preparar(t, { ensayo: true }))();
  assert.equal(r.tag, `ensayo-${RUN}`);
  assert.equal(r.ensayo, true);
});

test("el paquete de un ensayo no se acepta como versión real", async t => {
  const dir = await carpetaTemporal(t);
  const carpetaPaquete = join(dir, "origen");
  const p = paquete(carpetaPaquete, { ensayo: true });
  const o = origen({ ensayo: false, carpetaPaquete, manifiestoSha256: p.manifiestoSha256 });
  o.estado.artefactos[0].name = "entrega-v0.5.0";
  await assert.rejects(verificarCandidato({ destino: DESTINO, version: "0.5.0", runId: RUN, ensayo: false, dir: join(dir, "t"), ...o }), /ensayo/);
});

const casos = [
  ["otro workflow", { cambios: e => { e.run.path = ".github/workflows/ci.yml"; } }, /no de .github\/workflows\/candidato.yml/],
  ["lanzado por push", { cambios: e => { e.run.event = "push"; } }, /dispatch/],
  ["run en rojo", { cambios: e => { e.run.conclusion = "failure"; } }, /no terminó en verde/],
  ["rama que no es la de su release", { cambios: e => { e.run.head_branch = "main"; } }, /release\/0.5/],
  ["falta una plataforma", { cambios: e => { e.jobs = e.jobs.filter(j => j.name !== "macOS Intel (x64)"); } }, /Falta el job «macOS Intel/],
  ["falta el ensayo de actualización", { cambios: e => { e.jobs = e.jobs.filter(j => !j.name.startsWith("actualizar")); } }, /Falta el job «actualizar Windows»/],
  ["un job saltado", { cambios: e => { e.jobs[1].conclusion = "skipped"; } }, /no están en verde/],
  ["package.json con otra versión", { cambios: e => { e.version = "0.4.9"; } }, /dice 0.4.9/],
  ["commit fuera de la rama", { cambios: e => { e.compare = "diverged"; } }, /no está en release\/0.5/],
  ["sin tag", { cambios: e => { e.tagRef = null; } }, /Falta el tag v0.5.0/],
  ["tag ligero", { cambios: e => { e.tagRef = { object: { type: "commit", sha: SHA } }; } }, /no es un tag anotado/],
  ["tag en otro commit", { cambios: e => { e.tagAnotado.object.sha = "f".repeat(40); } }, /no el commit del candidato/],
  ["tag de otro run", { cambios: e => { e.tagAnotado.message = e.tagAnotado.message.replace(`"run_id":${RUN}`, '"run_id":1'); } }, /es del run 1/],
  ["dos artefactos", { cambios: e => { e.artefactos.push({ ...e.artefactos[0], id: 78 }); } }, /hay 2/],
  ["artefacto caducado", { cambios: e => { e.artefactos[0].expired = true; } }, /caducado/],
  ["artefacto sin digest", { cambios: e => { delete e.artefactos[0].digest; } }, /no trae digest/],
  ["zip cambiado", { cambios: e => { e.zip = Buffer.from("otro zip"); } }, /no coincide con el digest/],
  ["artefacto distinto del anotado", { cambios: e => { e.artefactos[0].id = 80; } }, /no es el que anotó el tag/],
  ["paquete del intento equivocado", { cambios: e => { for (const n of ["paquete", "candidato"]) e.jobs.find(j => j.name === n).run_attempt = 2; e.run.run_attempt = 2; } }, /intento 1/],
  ["un build repetido después del paquete", { cambios: e => { e.jobs.push({ name: "Windows (x64)", conclusion: "success", run_attempt: 2 }); e.run.run_attempt = 2; } }, /no recoge lo último/],
  ["el agregado anterior al paquete", { cambios: e => { e.jobs.push({ name: "paquete", conclusion: "success", run_attempt: 2 }); e.run.run_attempt = 2; } }, /anterior al paquete/],
  ["la última ejecución de un job en rojo", { cambios: e => { e.jobs.push({ name: "macOS Intel (x64)", conclusion: "failure", run_attempt: 2 }); } }, /macOS Intel \(x64\) \(failure\)/],
  ["un yml con otra huella SHA-512", { estropear: c => {
      // Un manifiesto del actualizador coherente con el release-manifest pero no con el fichero real.
      const ruta = join(c, "latest-x64.yml");
      const texto = readFileSync(ruta, "utf8").replace(/(sha512: >-\n\s+)\S+/g, `$1${"A".repeat(86)}==`);
      writeFileSync(ruta, texto);
      const m = JSON.parse(readFileSync(join(c, "release-manifest.json"), "utf8"));
      const f = m.files.find(x => x.name === "latest-x64.yml");
      f.size = Buffer.byteLength(texto); f.sha256 = createHash("sha256").update(texto).digest("hex");
      writeFileSync(join(c, "release-manifest.json"), JSON.stringify(m, null, 2) + "\n");
    }, anclaDelManifiesto: true }, /otra huella SHA-512/],
  ["fichero cambiado en el paquete", { estropear: c => writeFileSync(join(c, "6Keys-Practice-0.5.0-x64.exe"), "malicioso") }, /Tamaño distinto|Huella distinta/],
  ["fichero de más en el paquete", { estropear: c => writeFileSync(join(c, "extra.exe"), "x") }, /ficheros distintos/]
];

for (const [nombre, opciones, error] of casos) {
  test(`se rechaza: ${nombre}`, async t => {
    await assert.rejects((await preparar(t, opciones))(), error);
  });
}

test("se rechaza un manifiesto distinto del anotado en el tag", async t => {
  const dir = await carpetaTemporal(t);
  const carpetaPaquete = join(dir, "origen");
  paquete(carpetaPaquete);
  const o = origen({ carpetaPaquete, manifiestoSha256: "0".repeat(64) });
  await assert.rejects(verificarCandidato({ destino: DESTINO, version: "0.5.0", runId: RUN, dir: join(dir, "t"), ...o }), /no es el que anotó el tag/);
});

test("un «Re-run failed jobs» completo se acepta: cada job cuenta por su última ejecución", async t => {
  const r = await (await preparar(t, { cambios: e => {
    // Intento 1: Windows falló y todo lo que dependía de él no corrió.
    e.jobs = e.jobs.map(j => ["Windows (x64)", "paquete", "candidato"].includes(j.name) || j.name.startsWith("actualizar")
      ? { ...j, conclusion: j.name === "Windows (x64)" ? "failure" : "skipped" } : j);
    // Intento 2: solo se repiten esos; los Mac siguen siendo los del intento 1.
    for (const n of ["Windows (x64)", "actualizar Windows", "paquete", "candidato"]) e.jobs.push({ name: n, conclusion: "success", run_attempt: 2 });
    e.run.run_attempt = 2;
  }, estropear: c => {
    const m = JSON.parse(readFileSync(join(c, "release-manifest.json"), "utf8"));
    m.procedencia.run_attempt = 2;
    writeFileSync(join(c, "release-manifest.json"), JSON.stringify(m, null, 2) + "\n");
  }, anclaDelManifiesto: true }))();
  assert.equal(r.procedencia.paquete_attempt, 2);
});
