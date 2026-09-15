# Estrategia de pruebas del backend

## Resultado verificable

La batería actual ejecuta 187 escenarios y exige 100% en las cuatro métricas V8:

| Métrica | Cubierto | Total | Umbral CI |
|---|---:|---:|---:|
| Sentencias | 1271 | 1271 | 100% |
| Ramas | 898 | 898 | 100% |
| Funciones | 299 | 299 | 100% |
| Líneas | 1112 | 1112 | 100% |

La medición incluye todo `src/**/*.ts`, incluido `src/app.ts`. Sólo se excluyen `src/generated/**`, generado automáticamente por Prisma, y archivos `.d.ts`, que no contienen JavaScript ejecutable.

## Principio empírico

Los tests no reemplazan las respuestas exitosas del backend por valores prefabricados:

- PostgreSQL 17 aplica migraciones, restricciones, transacciones, advisory locks y consultas SQL reales sobre `laguillotina_test`.
- MinIO recibe PUT firmados, multipart, ETags, HEAD, finalización y abort reales mediante el SDK S3.
- El filesystem recibe y vuelve a servir los bytes exactos de cargas locales.
- Los PDFs se generan como bytes reales y se vuelven a analizar para comprobar páginas, texto Unicode, enlaces, destinos y marcadores; además se renderizan páginas representativas para revisión visual.
- El mailer de desarrollo escribe mensajes reales; SMTP se prueba mediante una conversación TCP real.
- Los E2E abren sockets HTTP en puertos efímeros, envían cookies/CSRF/multipart y atraviesan Fastify completo.
- Los fallos se inducen sobre infraestructura aislada: puerto ocupado, conexión SMTP rechazada, proveedor S3 malformado y tabla de logs temporalmente no disponible. Se comprueba la reacción real de la aplicación; no se fija de antemano su resultado.

Las pruebas destructivas sólo operan sobre la base `laguillotina_test` y las carpetas/buckets exclusivos del entorno de pruebas.

## Capas

### Arquitectura

`npm run test:architecture`

- detecta ciclos entre módulos productivos;
- prohíbe dependencias hacia tests o frontend;
- comprueba hash de contraseñas/tokens y borrado lógico en Prisma;
- comprueba prefijo único, ausencia de `/api/api`, operación OpenAPI por ruta, IDs únicos, respuestas y esquemas de seguridad.

### Integración

`npm run test:integration`

Ejecuta 107 escenarios de autenticación, sesiones, CSRF, roles, contenido, administración, comunidad, contacto, analítica, filesystem, PDF y S3/MinIO. Incluye publicación y selección de edición vigente, exportación A4 con índice enlazado, concurrencia de numeración editorial, idempotencia, paginación, validaciones, retención y borrado lógico.

### End-to-end

`npm run test:e2e`

- inicia el bootstrap productivo a partir de variables ambientales;
- comprueba readiness sobre TCP;
- recorre login, cookie, CSRF, alta editorial, publicación y lectura pública;
- carga multipart y descarga los mismos bytes;
- prueba CORS preflight en socket real;
- verifica recuperación controlada ante conflicto real de puerto.

### Estrés y concurrencia

`npm run test:stress`

La carga local reproducible comprende:

| Escenario | Solicitudes | Invariante | Umbral local |
|---|---:|---|---|
| Ráfaga pública mixta | 160 | cero respuestas fallidas | más de 10 req/s y p95 menor a 5 s |
| Altas editoriales | 40 concurrentes | 40 números y slugs únicos | p95 menor a 10 s |
| Carrera de votos | 24 concurrentes + inicial | una sola fila por identidad | todas 200 |

La ejecución del 12 de agosto de 2026 observó, en el equipo local usado para el desarrollo:

- lecturas: 70,90 req/s, p95 2.194,04 ms, cero fallos;
- escrituras: 59,73 req/s, p95 646,84 ms, cero fallos y cero colisiones;
- votos: 54,67 req/s, p95 435,94 ms, cero fallos y una fila final.

El archivo `test-results/stress-latest.json` se regenera en cada corrida y no se versiona. Estos valores sirven como smoke/load baseline local, no como capacidad garantizada del futuro hosting: la capacidad de producción debe medirse otra vez contra su red, pool, región, límites serverless y PostgreSQL administrado.

### Bordes y fallos

`npm run test:edge`

Cubre configuración parcial, errores Prisma reales, errores secundarios del logger, SMTP incompleto/rechazado, traversal, streams interrumpidos, S3 malformado, carga vencida/inexistente/finalizada, último admin, cuentas sin hash, OAuth parcial, fallbacks de serialización y señales de privacidad.

## Ejecución completa

```powershell
docker compose up -d
npm test
npm run test:coverage
npm run typecheck
npm run build
```

`minio-init` debe terminar con código 0: crea el bucket y sale. PostgreSQL y MinIO deben permanecer `healthy`.

## Qué garantiza y qué no

El estado verde garantiza que, bajo las versiones y condiciones ejecutadas, todos los escenarios, invariantes, contratos y umbrales documentados se cumplieron y que cada rama instrumentable del código productivo fue ejecutada.

No existe una prueba finita que garantice ausencia absoluta de bugs. El 100% de cobertura tampoco prueba por sí solo todas las combinaciones de datos, fallos de terceros, degradaciones del hosting o vulnerabilidades futuras. Antes de producción todavía corresponden pruebas de carga en el entorno desplegado, escaneo de dependencias/contenedores, DAST, pentest según riesgo, restauración de backups y pruebas de resiliencia de proveedores reales.
