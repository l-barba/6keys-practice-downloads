// Reglas puras de la entrega de 6Keys Practice: versiones, ficheros de una
// versión, manifiestos, procedencia y calendario. Sin red ni disco salvo el
// cálculo de huellas, para poder probarlas con datos inventados.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export const ORIGEN = "l-barba/6keys-practice";
export const WORKFLOW_CANDIDATO = ".github/workflows/candidato.yml";
export const MANIFIESTO = "release-manifest.json";

// Jobs que tienen que haber salido en verde en el run del candidato. El agregado
// `candidato` ya lo exige allí, pero esta lista es la comprobación INDEPENDIENTE:
// un PR a la rama de release que adelgazara `candidato.yml` (quitando una
// plataforma o el ensayo de actualización) no pasaría por aquí. Si se renombra
// un job allí, se cambia aquí en el mismo momento.
export const JOBS_DEL_CANDIDATO = [
  "preparar",
  "macOS Apple Silicon (arm64)",
  "macOS Intel (x64)",
  "Windows (x64)",
  "actualizar Windows",
  "paquete",
  "candidato"
];

/** «X.Y.Z», sin prefijo ni sufijo. Ser piloto es una marca de la release, no del número. */
export function versionEstable(texto) {
  const m = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.exec(String(texto ?? "").trim());
  if (!m) throw new Error(`Versión no válida: «${texto}». Se espera X.Y.Z.`);
  const texto_ = m.slice(1).join(".");
  return { texto: texto_, partes: m.slice(1).map(Number), tag: `v${texto_}`, rama: `release/${m[1]}.${m[2]}` };
}

/** >0 si a es posterior a b. Admite «X.Y.Z» y «vX.Y.Z». */
export function compararVersiones(a, b) {
  const pa = versionEstable(String(a).replace(/^v/, "")).partes;
  const pb = versionEstable(String(b).replace(/^v/, "")).partes;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** ¿Es el tag de una versión (vX.Y.Z)? Los ensayos usan `ensayo-<run>` y no cuentan. */
export function esTagDeVersion(tag) {
  return /^v\d+\.\d+\.\d+$/.test(tag ?? "");
}

/** El tag bajo el que se publica un paquete: el de la versión o, en un ensayo, uno fuera de `v*`. */
export function tagDelPaquete({ version, ensayo, runId }) {
  return ensayo ? `ensayo-${runId}` : versionEstable(version).tag;
}

/** Los ficheros que forman una versión, además del manifiesto. */
export function ficherosDeLaVersion(version) {
  const v = versionEstable(version).texto;
  return [
    `6Keys-Practice-${v}-x64.exe`,
    `6Keys-Practice-${v}-x64.exe.blockmap`,
    ...["x64", "arm64"].flatMap(arch => ["dmg", "zip"].flatMap(ext => [
      `6Keys-Practice-${v}-${arch}.${ext}`,
      `6Keys-Practice-${v}-${arch}.${ext}.blockmap`
    ])),
    "latest-x64.yml", "latest-x64-mac.yml", "latest-arm64-mac.yml"
  ];
}

/**
 * Exactamente los ficheros de la versión: ni repetidos, ni ajenos, ni faltas. Los
 * blockmap de dmg y zip son opcionales (electron-builder no siempre los genera);
 * el del .exe no, porque sin él Windows descarga la versión entera.
 */
export function comprobarFicheros(nombres, version) {
  const todos = ficherosDeLaVersion(version);
  const opcionales = new Set(todos.filter(n => /\.(dmg|zip)\.blockmap$/.test(n)));
  if (new Set(nombres).size !== nombres.length) throw new Error("Hay ficheros repetidos.");
  const ajenos = nombres.filter(n => !todos.includes(n));
  if (ajenos.length) throw new Error(`Ficheros ajenos a la versión: ${ajenos.join(", ")}`);
  const faltan = todos.filter(n => !opcionales.has(n) && !nombres.includes(n));
  if (faltan.length) throw new Error(`Faltan: ${faltan.join(", ")}`);
}

/**
 * El manifiesto que escribe el candidato (`scripts/entrega/preparar-paquete.mjs`
 * en el repo privado), esquema 2: la lista de ficheros con su huella y la
 * procedencia. Viaja como asset público de la release.
 */
export function comprobarManifiesto(m, { version, tag, ensayo, sha }) {
  const v = versionEstable(version);
  if (m?.schema !== 2) throw new Error("El manifiesto no es del esquema 2.");
  if (m.version !== v.texto || m.tag !== tag || m.ensayo !== Boolean(ensayo)) {
    throw new Error(`El manifiesto es de ${m.tag} (${m.version}${m.ensayo ? ", ensayo" : ""}), no de ${tag}.`);
  }
  if (sha !== undefined && m.commit !== sha) throw new Error("El manifiesto es de otro commit.");
  const p = m.procedencia;
  if (!p || p.repositorio !== ORIGEN || p.workflow !== WORKFLOW_CANDIDATO || !Number.isSafeInteger(p.run_id)
      || !Number.isSafeInteger(p.run_attempt) || !/^[a-f0-9]{40}$/.test(p.arbol ?? "") || typeof p.rama !== "string") {
    throw new Error("El manifiesto no trae una procedencia completa.");
  }
  if (!Array.isArray(m.files)) throw new Error("El manifiesto no lista ficheros.");
  comprobarFicheros(m.files.map(f => f.name), v.texto);
  for (const f of m.files) {
    if (!/^[a-f0-9]{64}$/.test(f.sha256 ?? "") || !Number.isSafeInteger(f.size) || f.size <= 0) {
      throw new Error(`Tamaño o huella no válidos: ${f.name}`);
    }
  }
  return m;
}

/**
 * Lee un manifiesto del actualizador (latest-*.yml) tal y como lo escribe
 * electron-builder, sin dependencias y sin aceptar nada más: claves conocidas,
 * valores en línea o plegados (`>-`) en la línea siguiente, sin comentarios ni
 * tabuladores. Lo que no reconoce lo rechaza: más vale un fallo visible al
 * publicar que una dirección que se cuela.
 */
const CLAVES_YML = new Set(["version", "files", "url", "sha512", "size", "path", "releaseDate", "blockMapSize"]);

// Solo la fecha puede ir entre comillas (simples, como la escribe js-yaml). En
// direcciones, huellas, tamaños y versión, una comilla es motivo de rechazo: no se
// adivina cómo la interpretaría el actualizador.
const CON_COMILLAS = new Set(["releaseDate"]);

export function leerYml(texto) {
  const lineas = String(texto).split(/\r?\n/);
  const r = { files: [] };
  const vistas = new Set();
  let actual = null;
  let enFiles = false;
  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i];
    if (/[#\t]/.test(linea)) throw new Error(`Manifiesto del actualizador con comentarios o tabuladores (línea ${i + 1}).`);
    if (linea.trim() === "") continue;
    const m = /^( *)(- )?([A-Za-z0-9]+):(?: (.*))?$/.exec(linea);
    if (!m) throw new Error(`Línea no reconocida en el manifiesto del actualizador (${i + 1}): ${linea}`);
    const [, sangria, guion, clave] = m;
    if (!CLAVES_YML.has(clave)) throw new Error(`Clave desconocida en el manifiesto del actualizador: ${clave}`);
    let valor = m[4] ?? "";
    if (valor === ">-" || valor === ">" || valor === "|") {
      const siguiente = lineas[i + 1] ?? "";
      if (!(siguiente.length - siguiente.trimStart().length > sangria.length + (guion ? 2 : 0))) {
        throw new Error(`Valor plegado sin contenido en «${clave}» (línea ${i + 1}).`);
      }
      valor = siguiente.trim();
      i++;
      const otra = lineas[i + 1] ?? "";
      if (otra.trim() && otra.length - otra.trimStart().length > sangria.length + (guion ? 2 : 0)) {
        throw new Error(`Valor de varias líneas en «${clave}»: no es lo que escribe electron-builder.`);
      }
    }
    if (CON_COMILLAS.has(clave) && /^'[^']*'$/.test(valor)) valor = valor.slice(1, -1);
    if (/['"]/.test(valor)) throw new Error(`Comillas inesperadas en «${clave}» (línea ${i + 1}).`);
    if (guion) {
      if (!enFiles || clave !== "url" || sangria !== "  ") throw new Error(`Entrada de «files» inesperada (línea ${i + 1}).`);
      actual = { url: valor };
      r.files.push(actual);
    } else if (sangria === "") {
      actual = null;
      if (vistas.has(clave)) throw new Error(`Clave repetida: ${clave}`);
      vistas.add(clave);
      enFiles = clave === "files";
      if (enFiles) { if (valor) throw new Error("«files» tiene que ser una lista."); continue; }
      r[clave] = valor;
    } else if (sangria === "    " && actual) {
      if (actual[clave] !== undefined) throw new Error(`Clave repetida en «files»: ${clave}`);
      actual[clave] = valor;
    } else {
      throw new Error(`Sangría inesperada en la línea ${i + 1}.`);
    }
  }
  return r;
}

/**
 * Un manifiesto del actualizador anuncia esta versión y apunta SOLO a los
 * ficheros permanentes de su tag en el repo de descargas, con los nombres que le
 * tocan por plataforma y arquitectura. Devuelve los ficheros a los que apunta,
 * con su SHA-512 y tamaño, para contrastarlos con los ficheros reales.
 */
export function comprobarYml(texto, { version, destino, tag, nombre }) {
  const v = versionEstable(version);
  const y = leerYml(texto);
  if (y.version !== v.texto) throw new Error(`${nombre} anuncia ${y.version}, no ${v.texto}.`);
  const base = `https://github.com/${destino}/releases/download/${tag}/`;
  const arch = nombre.includes("arm64") ? "arm64" : "x64";
  const extensiones = nombre.endsWith("-mac.yml") ? ["zip", "dmg"] : ["exe"];
  const permitidos = extensiones.map(ext => `${base}6Keys-Practice-${v.texto}-${arch}.${ext}`);
  if (y.files.length === 0) throw new Error(`${nombre} no lista ficheros.`);
  for (const f of y.files) {
    if (!permitidos.includes(f.url)) throw new Error(`${nombre} apunta fuera de lo permitido: ${f.url}`);
    if (!/^[A-Za-z0-9+/]{86}==$/.test(f.sha512 ?? "") || !/^\d+$/.test(f.size ?? "")) throw new Error(`${nombre}: huella o tamaño no válidos para ${f.url}`);
  }
  if (new Set(y.files.map(f => f.url)).size !== y.files.length) throw new Error(`${nombre} repite ficheros.`);
  if (!extensiones.every(ext => y.files.some(f => f.url.endsWith(`.${ext}`)))) throw new Error(`${nombre} no trae todos sus formatos.`);
  const principal = y.files.find(f => f.url === y.path);
  if (!principal || principal.sha512 !== y.sha512) throw new Error(`${nombre}: «path» y «sha512» no corresponden a uno de sus ficheros.`);
  return y.files.map(f => ({ nombre: decodeURIComponent(f.url.slice(base.length)), sha512: f.sha512, size: Number(f.size) }));
}

/** El viernes no se publica ni se promociona (hora de Madrid), salvo urgencia. */
export function esViernes(fecha) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Madrid", weekday: "short" }).format(fecha) === "Fri";
}

export function noEnViernes(fecha, que, urgencia) {
  if (!esViernes(fecha)) return;
  if (urgencia) return `Es viernes, pero hay urgencia: ${urgencia}`;
  throw new Error(`Hoy es viernes en Madrid: ${que} se deja para el lunes (o se declara urgencia, con motivo).`);
}

/** Fecha de hoy en Madrid, «AAAA-MM-DD». */
export function hoyEnMadrid(fecha) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(fecha);
}

/** Días completos entre dos fechas «AAAA-MM-DD». */
export function diasEntre(desde, hasta) {
  const d = Date.parse(`${desde}T00:00:00Z`), h = Date.parse(`${hasta}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || Number.isNaN(d)) throw new Error(`Fecha no válida: «${desde}». Se espera AAAA-MM-DD.`);
  return Math.floor((h - d) / 86_400_000);
}

export function sha256(datos) {
  return createHash("sha256").update(datos).digest("hex");
}

export async function sha256DeFichero(ruta) {
  const hash = createHash("sha256");
  for await (const trozo of createReadStream(ruta)) hash.update(trozo);
  return hash.digest("hex");
}

/** SHA-512 en base64, como lo escribe electron-builder en latest-*.yml. */
export async function sha512DeFichero(ruta) {
  const hash = createHash("sha512");
  for await (const trozo of createReadStream(ruta)) hash.update(trozo);
  return hash.digest("base64");
}

/**
 * ¿Es el mismo paquete? Compara lo que lo identifica —repo, run, commit, árbol,
 * intento del job que lo preparó, artefacto y huellas— y no los datos de
 * ejecución: repetir solo el último job del candidato cambia el intento del run,
 * no el paquete.
 */
const IDENTIDAD = ["repositorio", "run_id", "rama", "sha", "arbol", "paquete_attempt", "artefacto_id", "artefacto_digest", "manifiesto_sha256"];
export function mismaProcedencia(a, b) {
  return Boolean(a && b) && IDENTIDAD.every(k => a[k] !== undefined && a[k] === b[k]);
}

// Lo que se sabe de una release viaja en su cuerpo, en comentarios que GitHub no
// enseña: así promocionar revalida sin volver al repo privado, y la ficha del
// piloto queda guardada con la versión.
function marca(nombre, datos) {
  return `<!-- sixkeys-${nombre}: ${JSON.stringify(datos)} -->`;
}

function leerMarca(nombre, cuerpo) {
  const m = new RegExp(`<!-- sixkeys-${nombre}: (\\{.*?\\}) -->`, "s").exec(cuerpo ?? "");
  return m ? JSON.parse(m[1]) : null;
}

export const marcaDeProcedencia = datos => marca("candidato", datos);
export const leerProcedencia = cuerpo => leerMarca("candidato", cuerpo);
export const marcaDePiloto = datos => marca("piloto", datos);
export const leerPiloto = cuerpo => leerMarca("piloto", cuerpo);
export const marcaDeSustituida = datos => marca("sustituida", datos);
export const leerSustituida = cuerpo => leerMarca("sustituida", cuerpo);

/**
 * El ancla de un candidato nominado: el mensaje del tag anotado que crea
 * `candidato.yml` en el repo privado. Está FUERA del artefacto, así que un
 * paquete cambiado no puede traer consigo su propia huella buena.
 */
export function leerAnclaDelTag(mensaje) {
  const linea = (mensaje ?? "").split("\n").find(l => l.startsWith("sixkeys-candidato: "));
  if (!linea) throw new Error("El tag no trae la línea «sixkeys-candidato:» que escribe el candidato.");
  const ancla = JSON.parse(linea.slice("sixkeys-candidato: ".length));
  if (!Number.isSafeInteger(ancla.run_id) || !/^[a-f0-9]{64}$/.test(ancla.manifiesto_sha256 ?? "")
      || !Number.isSafeInteger(ancla.artefacto_id) || !/^sha256:[a-f0-9]{64}$/.test(ancla.artefacto_digest ?? "")) {
    throw new Error("La línea «sixkeys-candidato:» del tag está incompleta.");
  }
  return ancla;
}
