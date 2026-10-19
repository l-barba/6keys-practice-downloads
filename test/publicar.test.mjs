import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { publicarPiloto } from "../entrega/publicar.mjs";
import { leerProcedencia, leerSustituida, marcaDeProcedencia } from "../entrega/reglas.mjs";
import { ARBOL, DESTINO, RUN, SHA, carpetaTemporal, descargas, paquete, releaseDesdePaquete } from "./falso.mjs";

const LUNES = () => new Date("2026-10-19T09:00:00Z");
const VIERNES = () => new Date("2026-10-23T09:00:00Z");

async function preparar(t, { ensayo = false, releases, latest } = {}) {
  const dir = await carpetaTemporal(t);
  const p = paquete(dir, { ensayo });
  const verificado = {
    version: "0.5.0", tag: p.tag, manifiestoSha256: p.manifiestoSha256,
    procedencia: { repositorio: "l-barba/6keys-practice", run_id: RUN, run_attempt: 1, paquete_attempt: 1, rama: "release/0.5", sha: SHA, arbol: ARBOL,
      artefacto_id: 77, artefacto_digest: `sha256:${"9".repeat(64)}`, manifiesto_sha256: p.manifiestoSha256 }
  };
  const d = descargas({ releases, latest });
  const publicar = (extra = {}) => publicarPiloto({ destino: DESTINO, carpeta: dir, verificado, ensayo, ahora: LUNES, ...d, ...extra });
  return { dir, p, d, verificado, publicar };
}

const v041 = { id: 1, tag_name: "v0.4.1", draft: false, prerelease: false, body: "estable" };

test("publica como pre-release que NO es la latest, con la procedencia en el cuerpo", async t => {
  const { d, publicar, verificado } = await preparar(t, { releases: [v041], latest: "v0.4.1" });
  const r = await publicar();
  const rel = d.estado.releases.find(x => x.tag_name === "v0.5.0");
  assert.equal(rel.draft, false);
  assert.equal(rel.prerelease, true);
  assert.equal(rel.make_latest, "false");
  assert.equal(d.estado.latest, "v0.4.1");
  assert.match(rel.name, /piloto/);
  assert.deepEqual(leerProcedencia(rel.body), verificado.procedencia);
  assert.equal(rel.assets.length, 14, "13 ficheros de la versión y el manifiesto");
  assert.equal(r.tag, "v0.5.0");
  // El PATCH que publica repite la etiqueta (si no, GitHub la cambia por «untagged-…»).
  const patch = d.estado.llamadas.find(([m, , c]) => m === "PATCH" && c?.draft === false);
  assert.equal(patch[2].tag_name, "v0.5.0");
});

test("un ensayo crea, sube y comprueba el borrador, y lo borra sin publicar nada", async t => {
  const { d, publicar } = await preparar(t, { ensayo: true, releases: [v041], latest: "v0.4.1" });
  const r = await publicar();
  assert.equal(r.ensayo, true);
  assert.deepEqual(d.estado.releases.map(x => x.tag_name), ["v0.4.1"]);
  assert.ok(d.estado.llamadas.some(([m, ruta, c]) => m === "POST" && c?.tag_name === `ensayo-${RUN}`));
  assert.ok(!d.estado.llamadas.some(([m, , c]) => m === "PATCH" && c?.draft === false));
});

test("el viernes no se publica, salvo urgencia declarada", async t => {
  const a = await preparar(t, { releases: [v041], latest: "v0.4.1" });
  await assert.rejects(a.publicar({ ahora: VIERNES }), /viernes/);
  assert.equal(a.d.estado.releases.length, 1, "no se ha tocado nada");
  const b = await preparar(t, { releases: [v041], latest: "v0.4.1" });
  const avisos = [];
  await b.publicar({ ahora: VIERNES, urgencia: "clínica parada", log: m => avisos.push(m) });
  assert.ok(avisos.some(m => /urgencia/.test(m)));
});

test("no se publica una versión igual o anterior a una ya publicada", async t => {
  const { publicar } = await preparar(t, { releases: [{ ...v041, tag_name: "v0.6.0" }], latest: "v0.6.0" });
  await assert.rejects(publicar(), /no se publica una versión anterior/);
  const otra = await preparar(t, { releases: [{ ...v041, id: 2, tag_name: "v0.5.0", prerelease: true }], latest: null });
  await assert.rejects(otra.publicar(), /ya está publicada/);
});

test("un borrador de la misma etiqueta pero de otro candidato no se toca", async t => {
  const ajeno = { id: 3, tag_name: "v0.5.0", draft: true, body: marcaDeProcedencia({ sha: "f".repeat(40) }) };
  const { publicar } = await preparar(t, { releases: [v041, ajeno], latest: "v0.4.1" });
  await assert.rejects(publicar(), /de otro candidato/);
});

test("una carga a medias de este mismo candidato se rehace y se publica", async t => {
  const { d, publicar, verificado } = await preparar(t, { releases: [v041], latest: "v0.4.1" });
  d.estado.releases.push({ id: 4, tag_name: "v0.5.0", draft: true, body: `x\n${marcaDeProcedencia(verificado.procedencia)}`, assets: [{ id: 5, name: "6Keys-Practice-0.5.0-x64.exe", size: 1, updated_at: "t", datos: Buffer.from("a") }] });
  await publicar();
  const rel = d.estado.releases.find(x => x.tag_name === "v0.5.0");
  assert.equal(rel.draft, false);
  assert.equal(rel.assets.length, 14, "13 ficheros de la versión y el manifiesto");
  assert.ok(!rel.assets.some(a => a.id === 5), "el asset suelto de la carga anterior se borró");
});

test("si el manifiesto cambió entre verificar y publicar, no se sigue", async t => {
  const { dir, publicar } = await preparar(t, { releases: [v041], latest: "v0.4.1" });
  writeFileSync(join(dir, "release-manifest.json"), "{}");
  await assert.rejects(publicar(), /cambió entre la verificación y la publicación/);
});

test("un piloto nuevo sustituye al anterior que no llegó a promocionarse", async t => {
  const piloto050 = { id: 6, tag_name: "v0.4.2", draft: false, prerelease: true, body: "piloto anterior" };
  const { d, publicar } = await preparar(t, { releases: [v041, piloto050], latest: "v0.4.1" });
  await publicar();
  const anterior = d.estado.releases.find(x => x.tag_name === "v0.4.2");
  assert.deepEqual(leerSustituida(anterior.body), { por: "v0.5.0" });
  assert.match(anterior.name, /sustituida por 0.5.0/);
});

test("los ensayos huérfanos se borran; los borradores de versiones, no", async t => {
  const huerfano = { id: 7, tag_name: "ensayo-1", draft: true, body: "" };
  const borrador040 = { id: 8, tag_name: "v0.4.0", draft: true, body: "" };
  const { d, publicar } = await preparar(t, { releases: [v041, huerfano, borrador040], latest: "v0.4.1" });
  await publicar();
  assert.ok(!d.estado.releases.some(x => x.tag_name === "ensayo-1"));
  assert.ok(d.estado.releases.some(x => x.tag_name === "v0.4.0"));
});

test("un reintento después de publicar completa lo pendiente sin volver a publicar", async t => {
  const anterior = { id: 6, tag_name: "v0.4.2", draft: false, prerelease: true, body: "piloto anterior" };
  const base = await preparar(t, { releases: [v041, anterior], latest: "v0.4.1" });
  const ya = releaseDesdePaquete(base.dir, base.p.manifiesto, { id: 7, tag_name: "v0.5.0", body: `piloto\n${marcaDeProcedencia(base.verificado.procedencia)}` });
  base.d.estado.releases.push(ya);
  // Repetir solo el job «candidato» cambia el intento del run, no el paquete.
  const r = await base.publicar({ verificado: { ...base.verificado, procedencia: { ...base.verificado.procedencia, run_attempt: 2 } } });
  assert.equal(r.reanudada, true);
  assert.ok(!base.d.estado.llamadas.some(([m, , c]) => m === "POST" || (m === "PATCH" && c?.draft === false)), "ni borrador nuevo ni segunda publicación");
  assert.deepEqual(leerSustituida(base.d.estado.releases.find(x => x.tag_name === "v0.4.2").body), { por: "v0.5.0" });
});

test("si el mismo tag ya está publicado por otro candidato, o con otros ficheros, no se toca", async t => {
  const a = await preparar(t, { releases: [v041], latest: "v0.4.1" });
  a.d.estado.releases.push(releaseDesdePaquete(a.dir, a.p.manifiesto, { id: 7, tag_name: "v0.5.0", body: marcaDeProcedencia({ ...a.verificado.procedencia, sha: "f".repeat(40) }) }));
  await assert.rejects(a.publicar(), /de otro candidato/);
  const b = await preparar(t, { releases: [v041], latest: "v0.4.1" });
  const rel = releaseDesdePaquete(b.dir, b.p.manifiesto, { id: 7, tag_name: "v0.5.0", body: marcaDeProcedencia(b.verificado.procedencia) });
  rel.assets.find(x => x.name.endsWith(".exe")).digest = `sha256:${"0".repeat(64)}`;
  b.d.estado.releases.push(rel);
  await assert.rejects(b.publicar(), /no coincide con lo verificado/);
});

test("si el viernes llega mientras se suben los ficheros, no se publica", async t => {
  const fechas = [new Date("2026-10-22T21:50:00Z")]; // jueves 23:50 en Madrid; después, viernes
  const { d, publicar } = await preparar(t, { releases: [v041], latest: "v0.4.1" });
  await assert.rejects(publicar({ ahora: () => fechas.shift() ?? VIERNES() }), /viernes/);
  assert.ok(!d.estado.llamadas.some(([m, , c]) => m === "PATCH" && c?.draft === false));
});
