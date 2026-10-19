# 6keys-practice-downloads

Descargas oficiales de 6Keys Practice para Windows y macOS. Instaladores y actualizaciones de la aplicación.

## Qué versión instalar

- **La marcada como _Latest_** es la versión recomendada para todas las clínicas, y la que la aplicación ofrece al actualizarse.
- **Las marcadas como _Pre-release_ están en piloto**: se prueban primero en una clínica durante al menos una semana. No las instales salvo que te lo indiquemos. Si una dice «sustituida», no la instales nunca.

Cada versión trae `release-manifest.json` con la huella SHA-256 de cada fichero.

## Cómo se publica

Este repositorio no contiene el código de la aplicación. Contiene solo la automatización que comprueba y publica cada versión (`entrega/` y `.github/workflows/`):

1. **Piloto** (`piloto.yml`): comprueba en origen que la versión pasó el ensayo completo (Windows y los dos Mac, actualización desde la versión anterior) y que los ficheros son exactamente los ensayados; después la publica como _Pre-release_.
2. **Promoción** (`promocion.yml`): tras el piloto, la misma versión, con los mismos ficheros, pasa a ser _Latest_.

Las dos publicaciones requieren una aprobación humana. Las versiones publicadas son inmutables: sus ficheros no se pueden cambiar.
