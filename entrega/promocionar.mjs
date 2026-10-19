// Promociona la versión en piloto a todas las clínicas: la misma release, los
// mismos ficheros, solo cambian las marcas (deja de ser pre-release y pasa a ser
// la «latest», que es lo que consulta el actualizador). Nada se reconstruye ni se
// vuelve a subir.
//
// Lo ejecuta `promocion.yml`: primero el job `revisar` (sin permisos de escritura,
// para ver el resultado antes de pedir nada a Luis) y después `promocionar`,
// detrás del environment `clinicas` (aprobación de Luis), que vuelve a comprobarlo
// todo en el momento de ejecutarse.
import { appendFileSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MANIFIESTO, comprobarFicheros, comprobarManifiesto, comprobarYml, compararVersiones, diasEntre, esTagDeVersion,
  hoyEnMadrid, leerPiloto, leerProcedencia, leerSustituida, marcaDePiloto, marcaDeProcedencia, noEnViernes, sha256,
  sha256DeFichero, versionEstable
} from "./reglas.mjs";

export const DIAS_DE_PILOTO = 7;
export const MANIFIESTOS_DEL_ACTUALIZADOR = ["latest-x64.yml", "latest-x64-mac.yml", "latest-arm64-mac.yml"];

function exigir(condicion, mensaje) {
  if (!condicion) throw new Error(mensaje);
}

export function cuerpoPromocionado(version, procedencia, piloto) {
  const urgencia = piloto.urgencia ? ` Piloto acortado por urgencia: ${piloto.urgencia}.` : "";
  return [
    `Instaladores de 6Keys Practice ${version} para Windows y macOS.`,
    "",
    `Piloto en clínica del ${piloto.inicio} al ${piloto.fin} (${piloto.dias} días): copias verificadas, restauración de prueba y puestos funcionando, confirmado al aprobar la promoción.${urgencia}`,
    "",
    marcaDeProcedencia(procedencia),
    marcaDePiloto(piloto)
  ].join("\n");
}

/** Todo lo que se comprueba antes de cambiar las marcas. No escribe nada. */
/**
 * Los ficheros de la release: los de la versión, con las huellas del manifiesto
 * que se verificó al publicar el piloto, y los manifiestos del actualizador
 * apuntando solo a su tag. La release es inmutable, pero se comprueba igual.
 */
async function comprobarFicherosDeLaRelease({ destino, v, release, procedencia, descargar }) {
  const assets = release.assets ?? [];
  comprobarFicheros(assets.map(a => a.name).filter(n => n !== MANIFIESTO), v.texto);
  const tmp = await mkdtemp(join(tmpdir(), "sixkeys-promocion-"));
  try {
    const leer = async nombre => {
      const a = assets.find(x => x.name === nombre);
      exigir(a, `Falta ${nombre} en la release.`);
      const ruta = join(tmp, nombre);
      await descargar(`repos/${destino}/releases/assets/${a.id}`, ruta);
      return ruta;
    };
    const rutaManifiesto = await leer(MANIFIESTO);
    const bytes = readFileSync(rutaManifiesto);
    exigir(sha256(bytes) === procedencia.manifiesto_sha256, "El manifiesto publicado no es el que se verificó al publicar el piloto.");
    const manifiesto = comprobarManifiesto(JSON.parse(bytes), { version: v.texto, tag: v.tag, ensayo: false, sha: procedencia.sha });
    for (const f of manifiesto.files) {
      const a = assets.find(x => x.name === f.name);
      exigir(a && a.size === f.size, `Tamaño distinto en la release: ${f.name}`);
      // GitHub calcula la huella de cada asset; si faltara, se descarga y se calcula.
      const huella = a.digest ? a.digest.replace(/^sha256:/, "") : await sha256DeFichero(await leer(f.name));
      exigir(huella === f.sha256, `Huella distinta en la release: ${f.name}`);
    }
    for (const nombre of MANIFIESTOS_DEL_ACTUALIZADOR) {
      comprobarYml(readFileSync(await leer(nombre), "utf8"), { version: v.texto, destino, tag: v.tag, nombre });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function revisarPromocion({ destino, version, inicioPiloto, urgencia, ahora, api, todas, descargar }) {
  const v = versionEstable(version);
  const avisos = [];

  const release = await api(`repos/${destino}/releases/tags/${v.tag}`);
  exigir(release && release.draft === false, `${v.tag} no está publicada como piloto.`);
  exigir(release.immutable === true, `${v.tag} no es inmutable: sus ficheros podrían haber cambiado.`);
  exigir(!leerSustituida(release.body), `${v.tag} fue sustituida por otro piloto y no se promociona.`);
  const procedencia = leerProcedencia(release.body);
  exigir(procedencia?.sha && procedencia?.manifiesto_sha256, `${v.tag} no trae la procedencia que deja la publicación del piloto.`);

  if (release.prerelease === false) {
    // ¿Un reintento después de promocionar (por ejemplo, la caché del canal tardó
    // más de la cuenta)? Solo si es ya la «latest» y lleva la ficha de SU
    // promoción; entonces se comprueban los ficheros y el canal, y nada más.
    const latest = await api(`repos/${destino}/releases/latest`);
    const piloto = leerPiloto(release.body);
    exigir(latest?.tag_name === v.tag && piloto, `${v.tag} no es una versión en piloto (publicada de otra forma).`);
    await comprobarFicherosDeLaRelease({ destino, v, release, procedencia, descargar });
    avisos.push(`${v.tag} ya estaba promocionada (piloto del ${piloto.inicio} al ${piloto.fin}): solo se comprueba el canal.`);
    return { release, procedencia, piloto, latestAnterior: null, avisos, yaPromocionada: true };
  }

  const aviso = noEnViernes(ahora(), "promocionar", urgencia);
  if (aviso) avisos.push(aviso);

  // Un solo piloto activo, y es este: ninguna pre-release publicada más nueva.
  const releases = await todas(`repos/${destino}/releases`);
  const masNuevas = releases.filter(r => !r.draft && esTagDeVersion(r.tag_name) && compararVersiones(r.tag_name, v.tag) > 0);
  exigir(masNuevas.length === 0, `Hay publicada una versión posterior (${masNuevas.map(r => r.tag_name).join(", ")}): el piloto activo no es ${v.tag}.`);
  const latest = await api(`repos/${destino}/releases/latest`);
  if (latest) exigir(compararVersiones(v.tag, latest.tag_name) > 0, `La «latest» ya es ${latest.tag_name}: no se retrocede.`);

  // El plazo cuenta desde que la clínica piloto la INSTALÓ, no desde que se publicó.
  const hoy = hoyEnMadrid(ahora());
  const publicadaEl = hoyEnMadrid(new Date(release.published_at));
  exigir(diasEntre(publicadaEl, inicioPiloto) >= 0, `El piloto no puede empezar (${inicioPiloto}) antes de publicarse la versión (${publicadaEl}).`);
  const dias = diasEntre(inicioPiloto, hoy);
  exigir(dias >= 0, `El inicio del piloto (${inicioPiloto}) es posterior a hoy (${hoy}).`);
  if (dias < DIAS_DE_PILOTO) {
    exigir(urgencia, `El piloto lleva ${dias} días de ${DIAS_DE_PILOTO}. Solo una urgencia declarada, con motivo, lo acorta.`);
    avisos.push(`Piloto de ${dias} días, acortado por urgencia: ${urgencia}`);
  }

  await comprobarFicherosDeLaRelease({ destino, v, release, procedencia, descargar });

  const piloto = { inicio: inicioPiloto, fin: hoy, dias, ...(urgencia ? { urgencia } : {}) };
  return { release, procedencia, piloto, latestAnterior: latest?.tag_name ?? null, avisos };
}

export async function promocionar(opciones) {
  const { destino, version, api, leerFeed, esperar = ms => new Promise(r => setTimeout(r, ms)), log = () => {} } = opciones;
  const v = versionEstable(version);
  const r = await revisarPromocion(opciones);
  r.avisos.forEach(log);

  let hecha = r.release;
  if (!r.yaPromocionada) {
    // Justo antes del paso irreversible, otra vez el calendario.
    noEnViernes(opciones.ahora(), "promocionar", opciones.urgencia);
    hecha = await api(`repos/${destino}/releases/${r.release.id}`, "PATCH", {
      prerelease: false, make_latest: "true", name: `6Keys Practice ${v.texto}`,
      body: cuerpoPromocionado(v.texto, r.procedencia, r.piloto)
    });
  }
  exigir(hecha.prerelease === false && hecha.tag_name === v.tag, "La release no quedó como versión estable: revísala a mano.");
  const latest = await api(`repos/${destino}/releases/latest`);
  exigir(latest?.tag_name === v.tag, `La «latest» es ${latest?.tag_name}, no ${v.tag}: revísalo a mano.`);

  // Lo que ve de verdad una instalación: los tres manifiestos por la dirección del
  // canal. La caché de GitHub puede tardar un poco en enterarse.
  for (const nombre of MANIFIESTOS_DEL_ACTUALIZADOR) {
    const url = `https://github.com/${destino}/releases/latest/download/${nombre}`;
    let ultimo = "";
    for (let intento = 1; ; intento++) {
      ultimo = await leerFeed(url);
      if (new RegExp(`^version:\\s*['"]?${v.texto.replace(/\./g, "\\.")}['"]?\\s*$`, "m").test(ultimo)) break;
      exigir(intento < 12, `${url} sigue sin anunciar ${v.texto} tras ${intento} intentos.`);
      await esperar(15_000);
    }
    log(`${nombre}: el canal ya anuncia ${v.texto}.`);
  }
  return { ...r, release: hecha };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { conexion } = await import("./gh.mjs");
  const { api, todas, descargar } = conexion(process.env.GH_TOKEN);
  const opciones = {
    destino: process.env.GITHUB_REPOSITORY, version: process.env.VERSION, inicioPiloto: process.env.INICIO_PILOTO,
    urgencia: process.env.URGENCIA?.trim() || null, ahora: () => new Date(), api, todas, descargar,
    leerFeed: async url => { const res = await fetch(url, { redirect: "follow", cache: "no-store" }); return res.ok ? res.text() : ""; },
    log: m => console.log(m)
  };
  const real = process.argv.includes("--promocionar");
  const r = real ? await promocionar(opciones) : await revisarPromocion(opciones);
  const texto = [
    real ? `## ${r.release.tag_name} es ya la versión de todas las clínicas` : `## Revisión de la promoción de v${opciones.version}: todo en orden`,
    "",
    `Piloto: del ${r.piloto.inicio} al ${r.piloto.fin} (${r.piloto.dias} días).`,
    `Versión anterior en el canal: ${r.latestAnterior ?? "ninguna"}.`,
    `Commit: \`${r.procedencia.sha}\` · manifiesto \`sha256:${r.procedencia.manifiesto_sha256}\`.`,
    ...r.avisos.map(a => `> ${a}`), ""
  ].join("\n");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY ?? "/dev/null", texto);
  console.log(texto);
}
