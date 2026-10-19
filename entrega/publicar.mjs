// Publica un candidato YA VERIFICADO como versión en piloto: una pre-release que
// NO es la «latest», así que ninguna instalación la recibe sola; la clínica piloto
// la instala a mano. En un ensayo hace lo mismo hasta el borrador comprobado, y lo
// borra en vez de publicarlo.
//
// Lo ejecuta el job `publicar` de `piloto.yml`, detrás del environment `piloto`
// (aprobación de Luis), con el GITHUB_TOKEN de este repo. Todas las condiciones se
// revalidan aquí, al ejecutar: la aprobación puede llegar días después del dispatch.
import { appendFileSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MANIFIESTO, comprobarManifiesto, compararVersiones, esTagDeVersion, leerProcedencia, leerSustituida,
  marcaDeProcedencia, marcaDeSustituida, mismaProcedencia, noEnViernes, sha256, sha256DeFichero, versionEstable
} from "./reglas.mjs";

function exigir(condicion, mensaje) {
  if (!condicion) throw new Error(mensaje);
}

export function cuerpoDePiloto(version, procedencia) {
  return [
    `**Versión en piloto.** Todavía no es la recomendada: las clínicas siguen con la anterior hasta que termine el piloto.`,
    "",
    `Instaladores de 6Keys Practice ${version} para Windows y macOS.`,
    "",
    marcaDeProcedencia(procedencia)
  ].join("\n");
}

/** Las versiones publicadas (no borradores, no ensayos). */
function publicadas(releases) {
  return releases.filter(r => !r.draft && esTagDeVersion(r.tag_name));
}

export async function publicarPiloto({
  destino, carpeta, verificado, ensayo, urgencia, ahora, api, todas, subir, descargar, log = () => {}
}) {
  const v = versionEstable(verificado.version);
  const tag = verificado.tag;
  const repo = await api(`repos/${destino}`);
  exigir(repo && repo.private === false, "El repo de descargas tiene que ser público.");

  // El paquete que llega del job anterior se vuelve a contrastar con la huella que
  // ese job dejó como salida: un artefacto del run no es un sitio de confianza.
  const bytes = readFileSync(join(carpeta, MANIFIESTO));
  exigir(sha256(bytes) === verificado.manifiestoSha256, "El manifiesto cambió entre la verificación y la publicación.");
  const manifiesto = comprobarManifiesto(JSON.parse(bytes), { version: v.texto, tag, ensayo, sha: verificado.procedencia.sha });

  const releases = await todas(`repos/${destino}/releases`);
  const procedencia = verificado.procedencia;
  if (!ensayo) {
    const yaPublicada = publicadas(releases).find(r => r.tag_name === tag);
    if (yaPublicada) {
      // Un reintento después del paso irreversible (por ejemplo, falló marcar el
      // piloto anterior como sustituido). Solo se continúa si es EXACTAMENTE este
      // candidato y sus ficheros son los verificados; si no, nada se toca.
      exigir(mismaProcedencia(leerProcedencia(yaPublicada.body), procedencia), `${tag} ya está publicada, de otro candidato: un cambio exige otra versión.`);
      exigir(yaPublicada.prerelease === true, `${tag} ya está publicada y no como piloto: no se toca.`);
      comprobarAssetsPublicados(yaPublicada.assets ?? [], manifiesto, verificado.manifiestoSha256);
      log(`${tag} ya estaba publicada por este mismo candidato: se completa lo pendiente.`);
      await completarPiloto({ destino, tag, version: v.texto, releases, api, log });
      return { ensayo: false, tag, release: yaPublicada, reanudada: true };
    }
    // Antes de transferir nada; se repite justo antes de publicar.
    const aviso = noEnViernes(ahora(), "publicar el piloto", urgencia);
    if (aviso) log(aviso);
    for (const r of publicadas(releases)) {
      exigir(compararVersiones(tag, r.tag_name) > 0, `Ya hay publicada ${r.tag_name}: no se publica una versión anterior o igual.`);
    }
  }

  // Ensayos que se quedaron a medias: son borradores fuera de `v*`, nadie los ve y
  // se pueden borrar sin pensar.
  for (const r of releases.filter(r => r.draft && /^ensayo-\d+$/.test(r.tag_name) && r.tag_name !== tag)) {
    log(`Borrando un ensayo huérfano: ${r.tag_name}`);
    await api(`repos/${destino}/releases/${r.id}`, "DELETE");
  }

  const marcaEsperada = marcaDeProcedencia(procedencia);
  let borrador = releases.find(r => r.draft && r.tag_name === tag);
  if (borrador) {
    // Reanudar una carga a medias es seguro solo si es de ESTE candidato.
    exigir(mismaProcedencia(leerProcedencia(borrador.body), procedencia), `Ya hay un borrador de ${tag} de otro candidato: revísalo y bórralo a mano.`);
  } else {
    borrador = await api(`repos/${destino}/releases`, "POST", {
      tag_name: tag, target_commitish: repo.default_branch, draft: true, prerelease: true,
      name: `[Preparando] 6Keys Practice ${v.texto}${ensayo ? " (ensayo)" : ""}`,
      body: `Preparación en curso: no publicar a mano.\n\n${marcaEsperada}`
    });
  }

  const ficheros = manifiesto.files.map(f => f.name);
  let assets = await todas(`repos/${destino}/releases/${borrador.id}/assets`);
  if (!assets.some(a => a.name === MANIFIESTO)) {
    // Una carga parcial se rehace entera; el manifiesto se sube el último, así que
    // su presencia significa que lo demás terminó.
    for (const a of assets) await api(`repos/${destino}/releases/assets/${a.id}`, "DELETE");
    await subir(destino, tag, ficheros.map(n => join(carpeta, n)));
    await subir(destino, tag, [join(carpeta, MANIFIESTO)]);
    assets = await todas(`repos/${destino}/releases/${borrador.id}/assets`);
  }

  // Lo subido, otra vez desde GitHub: exactamente esos ficheros, con esas huellas.
  exigir(JSON.stringify(assets.map(a => a.name).sort()) === JSON.stringify([...ficheros, MANIFIESTO].sort()),
    "El borrador tiene ficheros distintos de los del manifiesto.");
  const tmp = await mkdtemp(join(tmpdir(), "sixkeys-borrador-"));
  try {
    for (const a of assets) {
      const ruta = join(tmp, a.name);
      await descargar(`repos/${destino}/releases/assets/${a.id}`, ruta);
      const huella = await sha256DeFichero(ruta);
      const esperada = a.name === MANIFIESTO ? verificado.manifiestoSha256 : manifiesto.files.find(f => f.name === a.name).sha256;
      exigir(huella === esperada, `El fichero subido no coincide: ${a.name}`);
      if (a.digest) exigir(a.digest === `sha256:${huella}`, `GitHub calcula otra huella para ${a.name}.`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const despues = await todas(`repos/${destino}/releases/${borrador.id}/assets`);
  exigir(JSON.stringify(despues.map(a => [a.id, a.size, a.updated_at]).sort()) === JSON.stringify(assets.map(a => [a.id, a.size, a.updated_at]).sort()),
    "El borrador cambió mientras se comprobaba.");

  if (ensayo) {
    await api(`repos/${destino}/releases/${borrador.id}`, "DELETE");
    log(`Ensayo completo: borrador ${tag} creado, subido, comprobado y borrado. No se ha publicado nada.`);
    return { ensayo: true, tag };
  }

  // Última revalidación justo antes del paso irreversible: subir y comprobar
  // cientos de megas lleva minutos, y en ellos puede haber llegado el viernes.
  noEnViernes(ahora(), "publicar el piloto", urgencia);
  const ahoraMismo = await todas(`repos/${destino}/releases`);
  exigir(!publicadas(ahoraMismo).some(r => compararVersiones(r.tag_name, tag) >= 0), "Mientras tanto se publicó una versión igual o posterior.");

  // La etiqueta SE REPITE en el PATCH: GitHub cambia por «untagged-…» la de un
  // borrador cuya etiqueta aún no existe si el PATCH no la trae (visto con 0.4.0 y
  // 0.4.1 el 2026-10-01), y entonces las direcciones permanentes de los
  // manifiestos quedarían muertas.
  const publicada = await api(`repos/${destino}/releases/${borrador.id}`, "PATCH", {
    tag_name: tag, draft: false, prerelease: true, make_latest: "false",
    name: `6Keys Practice ${v.texto} (piloto)`, body: cuerpoDePiloto(v.texto, procedencia)
  });
  exigir(publicada.tag_name === tag && publicada.draft === false && publicada.prerelease === true,
    `La publicación no quedó como pre-release de ${tag}: revisa la release a mano.`);

  await completarPiloto({ destino, tag, version: v.texto, releases: ahoraMismo, api, log });
  return { ensayo: false, tag, release: publicada, procedencia: leerProcedencia(publicada.body) };
}

/** Lo publicado tiene exactamente los ficheros del manifiesto verificado, con sus huellas. */
function comprobarAssetsPublicados(assets, manifiesto, manifiestoSha256) {
  const esperados = [...manifiesto.files.map(f => [f.name, f.size, f.sha256]), [MANIFIESTO, null, manifiestoSha256]];
  exigir(JSON.stringify(assets.map(a => a.name).sort()) === JSON.stringify(esperados.map(([n]) => n).sort()), "Lo publicado tiene ficheros distintos de los verificados.");
  for (const [nombre, size, huella] of esperados) {
    const a = assets.find(x => x.name === nombre);
    exigir(a.digest === `sha256:${huella}` && (size === null || a.size === size), `Lo publicado no coincide con lo verificado: ${nombre}`);
  }
}

/**
 * Lo que va después de publicar, y que un reintento tiene que poder terminar: la
 * versión no ha quedado como «latest», y cualquier piloto anterior que no llegó a
 * promocionarse queda marcado como sustituido (nunca hay dos pilotos activos).
 */
async function completarPiloto({ destino, tag, version, releases, api, log }) {
  const latest = await api(`repos/${destino}/releases/latest`);
  exigir(latest?.tag_name !== tag, `${tag} ha quedado como «latest»: revisa la release a mano.`);
  for (const r of publicadas(releases)) {
    if (!r.prerelease || r.tag_name === tag || leerSustituida(r.body)) continue;
    if (compararVersiones(r.tag_name, tag) >= 0) continue;
    if (latest && compararVersiones(r.tag_name, latest.tag_name) <= 0) continue;
    log(`El piloto ${r.tag_name} queda sustituido por ${tag}.`);
    await api(`repos/${destino}/releases/${r.id}`, "PATCH", {
      name: `6Keys Practice ${r.tag_name.slice(1)} (sustituida por ${version})`,
      body: `**Sustituida por ${version}: no instalar.**\n\n${r.body ?? ""}\n${marcaDeSustituida({ por: tag })}`
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { conexion } = await import("./gh.mjs");
  const { api, todas, descargar, subir } = conexion(process.env.GH_TOKEN);
  const verificado = {
    version: process.env.VERSION, tag: process.env.TAG, manifiestoSha256: process.env.MANIFIESTO_SHA256,
    procedencia: JSON.parse(process.env.PROCEDENCIA)
  };
  const r = await publicarPiloto({
    destino: process.env.GITHUB_REPOSITORY, carpeta: process.env.CARPETA, verificado,
    ensayo: process.env.ENSAYO === "true", urgencia: process.env.URGENCIA?.trim() || null,
    ahora: () => new Date(), api, todas, subir, descargar, log: m => console.log(m)
  });
  const texto = r.ensayo
    ? `## Ensayo de publicación completo\n\nBorrador \`${r.tag}\` creado, subido, comprobado y borrado. No se ha publicado nada.\n`
    : `## ${r.tag} publicada como versión en piloto\n\n[Abrir la release](${r.release.html_url}). No es la «latest»: ninguna instalación la recibe sola.\n\n` +
      `Siguiente paso: instalarla a mano en la clínica piloto (servidor y puestos) y apuntar el día. A los 7 días, con copias verificadas, restauración de prueba y puestos funcionando, se lanza \`promocion.yml\`.\n`;
  appendFileSync(process.env.GITHUB_STEP_SUMMARY ?? "/dev/null", texto);
  if (r.release) appendFileSync(process.env.GITHUB_OUTPUT ?? "/dev/null", `url=${r.release.html_url}\n`);
  console.log(texto);
}
