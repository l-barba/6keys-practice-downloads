import assert from "node:assert/strict";
import test from "node:test";
import { cuerpoPromocionado, promocionar, revisarPromocion } from "../entrega/promocionar.mjs";
import { leerPiloto, leerProcedencia, marcaDeProcedencia, marcaDeSustituida } from "../entrega/reglas.mjs";
import { ARBOL, DESTINO, RUN, SHA, carpetaTemporal, descargas, paquete, releaseDesdePaquete } from "./falso.mjs";

const v041 = { id: 1, tag_name: "v0.4.1", draft: false, prerelease: false, immutable: true, body: "estable", published_at: "2026-10-01T10:00:00Z" };
const LUNES_27 = () => new Date("2026-10-27T09:00:00Z");

async function preparar(t, { piloto = {}, otras = [] } = {}) {
  const dir = await carpetaTemporal(t);
  const p = paquete(dir);
  const procedencia = { run_id: RUN, sha: SHA, arbol: ARBOL, manifiesto_sha256: p.manifiestoSha256 };
  const rel = releaseDesdePaquete(dir, p.manifiesto, { tag_name: "v0.5.0", body: `piloto\n${marcaDeProcedencia(procedencia)}`, ...piloto });
  const d = descargas({ releases: [v041, rel, ...otras], latest: "v0.4.1" });
  const feed = { textos: [], lecturas: 0 };
  const opciones = (extra = {}) => ({
    destino: DESTINO, version: "0.5.0", inicioPiloto: "2026-10-20", ahora: LUNES_27, ...d,
    leerFeed: async () => { feed.lecturas++; return feed.textos.shift() ?? "version: 0.5.0\n"; },
    esperar: async () => {}, ...extra
  });
  return { d, opciones, feed, rel };
}

test("con 7 días de piloto, la misma release pasa a ser la latest y guarda la ficha del piloto", async t => {
  const { d, opciones } = await preparar(t);
  const r = await promocionar(opciones());
  const rel = d.estado.releases.find(x => x.tag_name === "v0.5.0");
  assert.equal(rel.prerelease, false);
  assert.equal(d.estado.latest, "v0.5.0");
  assert.deepEqual(leerPiloto(rel.body), { inicio: "2026-10-20", fin: "2026-10-27", dias: 7 });
  assert.equal(r.latestAnterior, "v0.4.1");
  // Solo marcas y texto: ni un asset nuevo ni borrado.
  assert.ok(!d.estado.llamadas.some(([m, ruta]) => m === "DELETE" || ruta.includes("assets") && m !== "GET"));
});

test("revisar no escribe nada", async t => {
  const { d, opciones } = await preparar(t);
  await revisarPromocion(opciones());
  assert.ok(d.estado.llamadas.every(([m]) => m === "GET"));
});

test("el plazo cuenta desde la instalación en la clínica, no desde la publicación", async t => {
  const { opciones } = await preparar(t);
  await assert.rejects(revisarPromocion(opciones({ inicioPiloto: "2026-10-23" })), /lleva 4 días de 7/);
  await assert.rejects(revisarPromocion(opciones({ inicioPiloto: "2026-10-01" })), /antes de publicarse/);
  await assert.rejects(revisarPromocion(opciones({ inicioPiloto: "2026-10-30" })), /posterior a hoy/);
});

test("una urgencia declarada acorta el piloto y permite el viernes, y queda escrita", async t => {
  const { d, opciones } = await preparar(t);
  await assert.rejects(promocionar(opciones({ ahora: () => new Date("2026-10-23T09:00:00Z") })), /viernes/);
  await promocionar(opciones({ ahora: () => new Date("2026-10-23T09:00:00Z"), inicioPiloto: "2026-10-22", urgencia: "copias que no se cierran" }));
  const rel = d.estado.releases.find(x => x.tag_name === "v0.5.0");
  assert.equal(leerPiloto(rel.body).urgencia, "copias que no se cierran");
  assert.match(rel.body, /acortado por urgencia/);
});

const rechazos = [
  ["ya promocionada", { piloto: { prerelease: false } }, /no es una versión en piloto/],
  ["no inmutable", { piloto: { immutable: false } }, /no es inmutable/],
  ["sustituida por otro piloto", { piloto: { body: `x\n${marcaDeSustituida({ por: "v0.5.1" })}` } }, /sustituida/],
  ["sin procedencia", { piloto: { body: "piloto sin marca" } }, /procedencia/],
  ["hay un piloto más nuevo", { otras: [{ id: 9, tag_name: "v0.5.1", draft: false, prerelease: true, body: "" }] }, /posterior \(v0.5.1\)/]
];
for (const [nombre, opciones_, error] of rechazos) {
  test(`no se promociona: ${nombre}`, async t => {
    const { opciones } = await preparar(t, opciones_);
    await assert.rejects(promocionar(opciones()), error);
  });
}

test("no se promociona si un asset no tiene la huella del manifiesto verificado", async t => {
  const { rel, opciones } = await preparar(t);
  rel.assets.find(a => a.name.endsWith(".exe")).digest = `sha256:${"0".repeat(64)}`;
  await assert.rejects(promocionar(opciones()), /Huella distinta/);
});

test("se espera a que el canal anuncie la versión, con un límite", async t => {
  const a = await preparar(t);
  a.feed.textos = ["version: 0.4.1\n", "version: 0.4.1\n"];
  await promocionar(a.opciones());
  assert.ok(a.feed.lecturas >= 5, "tres manifiestos, uno de ellos con dos esperas");
  const b = await preparar(t);
  b.feed.textos = Array(20).fill("version: 0.4.1\n");
  await assert.rejects(promocionar(b.opciones()), /sigue sin anunciar 0.5.0/);
});

test("un reintento después de promocionar solo comprueba el canal, sin tocar las marcas ni la ficha", async t => {
  const { d, opciones } = await preparar(t);
  const rel = d.estado.releases.find(x => x.tag_name === "v0.5.0");
  rel.prerelease = false;
  rel.body = cuerpoPromocionado("0.5.0", leerProcedencia(rel.body), { inicio: "2026-10-20", fin: "2026-10-27", dias: 7 });
  d.estado.latest = "v0.5.0";
  // Un viernes, y con otra fecha de inicio: lo irreversible ya está hecho, y la ficha no se reescribe.
  const r = await promocionar(opciones({ ahora: () => new Date("2026-10-30T09:00:00Z"), inicioPiloto: "2026-10-28" }));
  assert.equal(r.yaPromocionada, true);
  assert.ok(!d.estado.llamadas.some(([m]) => m === "PATCH"));
  assert.deepEqual(leerPiloto(d.estado.releases.find(x => x.tag_name === "v0.5.0").body), { inicio: "2026-10-20", fin: "2026-10-27", dias: 7 });
});

test("una versión estable que no salió de una promoción no se toca", async t => {
  const { d, opciones } = await preparar(t, { piloto: { prerelease: false } });
  d.estado.latest = "v0.5.0";
  await assert.rejects(promocionar(opciones()), /publicada de otra forma/);
});

test("si el viernes llega durante la revisión, no se promociona", async t => {
  const fechas = [new Date("2026-10-22T21:50:00Z")]; // jueves 23:50 en Madrid; después, viernes
  const { d, opciones } = await preparar(t);
  await assert.rejects(promocionar(opciones({ inicioPiloto: "2026-10-12", ahora: () => fechas.shift() ?? new Date("2026-10-23T09:00:00Z") })), /viernes/);
  assert.ok(!d.estado.llamadas.some(([m]) => m === "PATCH"));
});
