---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-04T23:27:26-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-04T23:22:10-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "Decisions Detail sem o texto das Revisions de TD-03/04/06/08 anunciadas no Index"
    resolved_by: clarification
  - id: AMB-1
    status: resolved
    summary: "Subprojetos afetados não declarados: fronteira de FE e worker indefinida"
    resolved_by: clarification
  - id: AMB-2
    status: resolved
    summary: "Upload: \"sem impacto na performance\" não tem critério de aceite mensurável"
    resolved_by: clarification
  - id: AMB-3
    status: resolved
    summary: "Upload: contrato de entrada indefinido (semântica de 10GB, formatos aceitos)"
    resolved_by: clarification
  - id: AMB-4
    status: resolved
    summary: "Pré-cadastro: dados do rascunho, dono (usuário/canal) e fronteira com Fase 04"
    resolved_by: clarification
  - id: AMB-5
    status: resolved
    summary: "Processamento: \"metadados\" indefinidos; transcodificação dentro ou fora?"
    resolved_by: clarification
  - id: AMB-6
    status: resolved
    summary: "URL única: qual URL (frontend/API/storage) e em que momento é gerada"
    resolved_by: clarification
  - id: AMB-7
    status: resolved
    summary: "URLs pré-assinados para o cliente: endpoint público do storage não definido"
    resolved_by: phase-03-videos/TD-02
  - id: AMB-8
    status: resolved
    summary: "Streaming/download: validade (TTL) do URL pré-assinado de TD-08 indefinida"
    resolved_by: phase-03-videos/TD-08
  - id: AMB-9
    status: resolved
    summary: "Stream/download: estado exigido do vídeo e TTL quando duration_seconds é nulo"
    resolved_by: phase-03-videos/TD-08
  - id: AMB-10
    status: resolved
    summary: "Download: Content-Disposition e nome do arquivo baixado não definidos"
    resolved_by: phase-03-videos/TD-08
  - id: DG-1
    status: resolved
    summary: "Gatilho upload concluído → job de processamento sem TD responsável"
    resolved_by: clarification
  - id: ICC-1
    status: resolved
    summary: "TD-10 vs phase-02-auth/TD-08: throttler global ou escopado ao AuthModule?"
    resolved_by: phase-02-auth/TD-08
  - id: ICC-2
    status: resolved
    summary: "TD-03 (upload direto ao storage) vs BFF herdado: toda mutação em app/api/**"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-1
    status: resolved
    summary: "phase-03-videos/TD-01 pending — Background Job Queue Technology"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "phase-03-videos/TD-02 pending — Object Storage Access, Bucket and Key Layout"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "phase-03-videos/TD-03 pending — Large Video Upload Protocol (up to 10 GB)"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "phase-03-videos/TD-04 pending — Video Status Lifecycle and Failure Policy"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "phase-03-videos/TD-05 pending — Video Worker Runtime"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "phase-03-videos/TD-06 pending — Media Probing and Thumbnail Generation"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "phase-03-videos/TD-07 pending — Unique Video URL Identifier"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "phase-03-videos/TD-08 pending — Streaming and Download Delivery"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "phase-03-videos/TD-09 pending — Video Access Control in Phase 03"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "phase-03-videos/TD-10 pending — Rate Limiting on Video Endpoints"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "phase-03-videos/TD-11 pending — Test Strategy for Storage, Queue and Worker"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-12
    status: resolved
    summary: "phase-03-videos/TD-12 pending — Storage Growth and Cleanup Policy"
    resolved_by: phase-03-videos/TD-12
  - id: AMB-11
    status: resolved
    summary: "Conclusão: resposta HTTP quando o HeadObject pós-montagem diverge do declarado"
    resolved_by: phase-03-videos/TD-03
  - id: AMB-12
    status: resolved
    summary: "MinIO no Compose: imagem fixada e expiração de multipart não constam do context"
    resolved_by: phase-03-videos/TD-02
  - id: AMB-13
    status: resolved
    summary: "Retry de complete após 503 QUEUE_UNAVAILABLE com o multipart já montado"
    resolved_by: phase-03-videos/TD-03
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

Esta rodada parte do `context.md` atualizado por `/plan-resolve 3`, que tratou AMB-12 e AMB-13. O `## Decisions Detail` traz os 17 bullets `**Revisions:**` do decisions doc, conferidos por diff byte a byte: TD-01: 1, TD-02: 2, TD-03: 5, TD-04: 2, TD-06: 2, TD-07: 1, TD-08: 3, TD-12: 1. As linhas `└─ Last revision` de TD-02, TD-03 e TD-12 apontam para os bullets novos. Os 12 TDs estão `decided`, e todo `Capability:` cita um bullet de `## Scope`.

Pontos conferidos que não viram issue:

- A Revision "Completion retry after an enqueue failure" de TD-03 refina a "Upload error contract" e não a contradiz. O "storage reports the upload gone" de `GET /videos/{publicId}/upload` passa a ter dois ramos: com o objeto original montado, `409 INVALID_VIDEO_STATE`; sem objeto, `410 UPLOAD_EXPIRED` e `failed`. Em `upload/complete`, os estados ficam todos cobertos: `draft` normal, `draft` com objeto montado (`202`), `draft` sem upload nem objeto (`410`), `processing` (`202` com o mesmo `jobId`), `ready`/`failed` (`409 INVALID_VIDEO_STATE`) e draft vencido (lazy expiry de TD-04 → `410`).
- Um draft com o objeto montado que passa de `upload_expires_at` vira `failed` com `UPLOAD_EXPIRED` na lazy expiry, e o objeto fica no bucket. Isso segue a Decision A de TD-12 ("originals kept"). A limpeza fica no follow-up de produção registrado na Recommendation de TD-12 ("a scheduled job ... recorded as production follow-ups").
- A janela de upload de 24 h (TD-03) e `MINIO_API_STALE_UPLOADS_EXPIRY=24h` (Revision de TD-12) têm o mesmo valor, como a Recommendation de TD-03 exige ("aligned with MinIO's stale-upload expiry").
- `PROCESSING_FAILED` tem três gatilhos: retries esgotadas, job travado (Revision de TD-04) e `HeadObject` pós-montagem divergente (Revision "Size mismatch outcome" de TD-03). O Error Catalog do plano deve listar os três.

**Varredura dry-run do build.** Todo valor concreto que o plano precisa citar foi procurado no `context.md`, no `library-refs.md` e no `testing-guide-nestjs-project`:

| Grupo | Valores | Fonte |
|-------|---------|-------|
| Serviços e imagens do Compose | `minio` e `minio-init` com `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, healthcheck `curl -f http://localhost:9000/minio/health/live`, `mc mb --ignore-existing`, `service_completed_successfully`; `redis` com `noeviction` + `appendonly yes` e dependência `service_healthy`; `video-worker` com `restart: unless-stopped` e graceful stop; FFmpeg na imagem de dev compartilhada | TD-02 e TD-05 (Revision/Recommendation); `library-refs.md` § `bullmq`; guide § "Video Worker and FFmpeg" |
| Variáveis de ambiente | `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `QUEUE_PREFIX`, `MINIO_API_STALE_UPLOADS_EXPIRY`; `S3_BUCKET`; `REDIS_HOST`/`REDIS_PORT` | TD-02, TD-01, TD-12; guide § "Object Storage"; `library-refs.md` § `@nestjs/bullmq` |
| Campos e códigos da API | entrada de `POST /videos`, campos de `GET /videos/{publicId}`, `{ url, expires_at }`, `VALIDATION_ERROR`, `STORAGE_UNAVAILABLE`, `INVALID_VIDEO_STATE`, `UPLOAD_EXPIRED`, `UPLOAD_INCOMPLETE`, `UPLOAD_SIZE_MISMATCH`, `QUEUE_UNAVAILABLE`, `VIDEO_NOT_FOUND`, `VIDEO_NOT_READY` | Revisions de TD-03, TD-04, TD-07, TD-08 |
| Fila e job | `video-processing`, `process-video`, payload `{ videoId }`, `jobId` = uuid, `attempts: 3`, backoff exponencial de 1000 ms, `enableOfflineQueue: false` | Revisions de TD-01 e TD-04 |
| TTLs e janelas | partes 1 h, janela 24 h, stream `clamp(2 × duration_seconds, 3600, 43200)`, download 3600 s, thumbnail 3600 s | TD-03 (Recommendation), Revisions de TD-08 e TD-06 |
| Chaves de storage e buckets | `videos/{videoId}/original`, `videos/{videoId}/thumbnail.jpg`, `streamtube`, `streamtube-test` | Revisions de TD-03 e TD-02; TD-06 (Recommendation) |
| Campos do `metadata` | `width`, `height`, `video_codec`, `audio_codec`, `bit_rate`, `frame_rate`, `format_name`; `duration_seconds` em coluna própria | Revision "Metadata shape" de TD-06 |
| Isolamento de testes | bucket e prefixo `streamtube-test`, setup do Jest depois de `dotenv/config`, `emptyTestBucket` e `obliterate` guardados por `test`, fixtures `ffmpeg -f lavfi`, worker in-process nos e2e | TD-11; guide § "External systems" |

Ficaram de fora das três fontes, e passam pelo critério (d)+(a), porque são nomenclatura ou parâmetro operacional sem escolha de comportamento: a tag da imagem Redis (imagem oficial ainda publicada, ao contrário do caso do MinIO de AMB-12), os nomes das envs de credencial e região do storage e das credenciais root do MinIO, os nomes das envs de concorrência do worker (TD-05: padrão 1) e de backoff (TD-04: padrão 1000 ms), o valor do `stop_grace_period`, o nome da coluna que guarda o `UploadId` e a forma JSON das respostas de `POST /videos` e `GET /videos/{publicId}/upload`. A semântica dessas respostas já está fixada: tamanho de parte de 64 MiB, URLs por número de parte com TTL de 1 h, retomada que reassina só as partes que faltam (`library-refs.md` § multipart) e `upload_expires_at`.

### Ambiguities

_None._

### Missing Decisions

_None._

Os 9 bullets de `## Capability Coverage` têm ao menos um TD decidido. O formato de erro HTTP do `nestjs-project` vem de `phase-02-auth/TD-07`, e a estratégia de contrato OpenAPI vem de `openapi-docs-nestjs/TD-01`..`TD-03`. O check de sincronização de tipos FE↔BE (Decisão #29) não dispara, porque `## UI Inventory` está com o placeholder de adiado.

### Dependency Gaps

_None._

As dependências de fases anteriores estão entregues: autenticação JWT e `Channel` 1:1 com `User` (`phase-02-auth`), config `registerAs` + Joi e TypeORM (`phase-01-configuracao-base`). Dentro da fase, a ordem fica implícita nos próprios TDs: storage e fila (TD-01, TD-02) antes do upload (TD-03), o upload antes do job (TD-04, TD-05) e o processamento antes de stream e download (TD-08 exige `ready`).

### Inherited Constraint Conflicts

_None._

A divergência entre `phase-03-videos/TD-10` e `phase-02-auth/TD-08` continua resolvida pela Revision em `phase-02-auth/TD-08` (ICC-1). O split plano de controle × plano de dados de TD-03 continua conciliado com o BFF herdado (ICC-2). As Revisions novas (imagem e buckets do MinIO, expiração de multipart, retry da conclusão) não tocam em convenção herdada: usam o envelope de `phase-02-auth/TD-07` e códigos que já existem.

### Unresolved Open Questions

_None._

Nenhum TD está `pending`. A inventory está adiada (`## UI Inventory` com o placeholder), então não há Open Questions de inventory a ingerir.

### UI Coverage Gaps

_None._ _(`## UI Inventory` está com o placeholder de adiado; o check 7 não se aplica.)_

## Resolved Issues

- **AMB-1** _(resolved_by clarification)_ — Subprojetos afetados não declarados: fronteira de FE e worker indefinida. Opção (a), fase só backend.
  - `docs/project-plan.md` passou a declarar na Fase 03: "Subprojetos: `nestjs-project` (API, worker de vídeo e infraestrutura). `next-frontend` diferido: a interface de vídeo fica para as Fases 04 e 05."
  - O `context.md` regenerado traz `nestjs-project` em Affected subprojects e `next-frontend` em Deferred subprojects. O worker roda no mesmo codebase, com entrypoint e container próprios (`phase-03-videos/TD-05`), e o lado cliente de TD-03/TD-08 fica como contrato HTTP documentado.
  - `## Testing Requirements` cobre `nestjs-project` e marca `next-frontend` como diferido.
- **AMB-2** _(resolved_by clarification)_ — Upload: "sem impacto na performance" não tem critério de aceite mensurável. Opção (a), critério estrutural: os bytes do vídeo nunca passam pelo processo da API (upload direto ao storage, `phase-03-videos/TD-03`) e o FFmpeg roda em outro container (`phase-03-videos/TD-05`). Assim, memória e CPU da API ficam limitadas independentemente do tamanho do arquivo.
- **AMB-3** _(resolved_by clarification)_ — Upload: contrato de entrada indefinido (semântica de 10GB, formatos aceitos). Opções (a1) + (b1):
  - Limite de 10 GiB binário = 10.737.418.240 bytes, validado na iniciação pelo tamanho declarado e reconferido na conclusão (`phase-03-videos/TD-03`).
  - Allowlist de containers por MIME e extensão, confirmada pelo probing de `phase-03-videos/TD-06`: `video/mp4` (.mp4), `video/quicktime` (.mov), `video/webm` (.webm), `video/x-matroska` (.mkv).
- **AMB-4** _(resolved_by clarification)_ — Pré-cadastro: dados do rascunho, dono (usuário/canal) e fronteira com Fase 04.
  - Dados (a), rascunho mínimo automático: `title` opcional no início do upload e, se ausente, derivado do nome do arquivo sem extensão; sem descrição.
  - Edição de metadados e publicação ficam na Fase 04.
  - Dono (i): o canal do usuário (`channel_id`).
- **AMB-5** _(resolved_by clarification)_ — Processamento: "metadados" indefinidos; transcodificação dentro ou fora? Opção (a), só probing: duração, largura, altura, codecs, container, bitrate, fps e tamanho. O streaming serve o original via Range (`phase-03-videos/TD-08` A). Sem transcodificação nesta fase, registrada como limitação.
- **AMB-6** _(resolved_by clarification)_ — URL única: qual URL (frontend/API/storage) e em que momento é gerada. Opções (a) + (x): o backend gera só o identificador (`public_id`, `phase-03-videos/TD-07`), reutilizado nas rotas `/videos/{publicId}` da API e na futura rota do frontend. Ele é criado junto com o rascunho no pré-cadastro, porque as rotas de upload já o usam.
- **DG-1** _(resolved_by clarification)_ — Gatilho upload concluído → job de processamento sem TD responsável. Opção (a): a API publica o job na fila (`phase-03-videos/TD-01`) quando o cliente confirma a conclusão do upload (`POST /videos/{publicId}/upload/complete`, passo final de `phase-03-videos/TD-03`), com a transição `draft → processing` de `phase-03-videos/TD-04`. Isso já estava previsto nas recomendações de TD-03 e TD-04; nenhum campo de TD foi alterado.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — phase-03-videos/TD-01 pending — Background Job Queue Technology. Decision **A (BullMQ + Redis)**. Libraries: `@nestjs/bullmq@^12.0.0`, `bullmq@^6.4.0`.
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — phase-03-videos/TD-02 pending — Object Storage Access, Bucket and Key Layout. Decision **A (AWS SDK v3 + single private bucket with per-video prefixes)**. Libraries: `@aws-sdk/client-s3@^3.1154.0`, `@aws-sdk/s3-request-presigner@^3.1154.0`.
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — phase-03-videos/TD-03 pending — Large Video Upload Protocol (up to 10 GB). Decision **A (S3 multipart with presigned part URLs)**. Sem libraries novas (usa as de TD-02).
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — phase-03-videos/TD-04 pending — Video Status Lifecycle and Failure Policy. Decision **A (Single processing-lifecycle enum with bounded retries)**.
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — phase-03-videos/TD-05 pending — Video Worker Runtime. Decision **A (Same NestJS codebase, separate entrypoint and container)**.
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — phase-03-videos/TD-06 pending — Media Probing and Thumbnail Generation. Decision **A (Spawn ffprobe/ffmpeg against a presigned internal URL)**. FFmpeg é binário do sistema, não pacote npm.
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — phase-03-videos/TD-07 pending — Unique Video URL Identifier. Decision **B (Random short public ID with unique index and retry)**.
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — phase-03-videos/TD-08 pending — Streaming and Download Delivery. Decision **A (Presigned GET URL returned as JSON)**.
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — phase-03-videos/TD-09 pending — Video Access Control in Phase 03. Decision **A (Owner-only for every video endpoint)**.
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — phase-03-videos/TD-10 pending — Rate Limiting on Video Endpoints. Decision **A (`@SkipThrottle()` on the videos controller)**.
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — phase-03-videos/TD-11 pending — Test Strategy for Storage, Queue and Worker. Decision **A (Real MinIO, Redis and FFmpeg, isolated by test bucket and queue prefix)**.
- **OQ-12** _(resolved_by phase-03-videos/TD-12)_ — phase-03-videos/TD-12 pending — Storage Growth and Cleanup Policy. Decision **A (Storage-side expiry + lazy draft expiry)**.
- **AMB-7** _(resolved_by phase-03-videos/TD-02)_ — URLs pré-assinados para o cliente: endpoint público do storage não definido. Opção (a), Revision 2026-11-04 em `phase-03-videos/TD-02` (Decision A mantida):
  - A config `storage` tem dois endpoints. `S3_ENDPOINT` (interno, `http://minio:9000`) atende a API e o worker em todas as operações de servidor, inclusive a assinatura das URLs internas que o worker passa ao FFmpeg (TD-06).
  - `S3_PUBLIC_ENDPOINT` é usado só por um segundo `S3Client`, que assina as URLs entregues ao cliente (partes do TD-03, stream e download do TD-08), porque a SigV4 assina o `host`.
  - No Compose de dev e nos testes, `S3_PUBLIC_ENDPOINT` = `http://minio:9000`; para um cliente no host, o valor é sobrescrito para `http://localhost:9000`.
- **AMB-8** _(resolved_by phase-03-videos/TD-08)_ — Streaming/download: validade (TTL) do URL pré-assinado de TD-08 indefinida. Opção (b), Revision 2026-11-04 em `phase-03-videos/TD-08` (Decision A mantida):
  - TTL do stream = `clamp(2 × duration_seconds, 3600 s, 43200 s)`, porque cada requisição Range é uma requisição assinada nova durante a reprodução.
  - TTL do download = 3600 s, porque a assinatura é verificada no início da transferência e um download longo continua depois de expirar.
  - As duas respostas trazem `expires_at`. Os TTLs são diferentes.
- **ICC-1** _(resolved_by phase-02-auth/TD-08)_ — TD-10 vs phase-02-auth/TD-08: throttler global ou escopado ao AuthModule? Opção (a), Revision 2026-11-04 no TD herdado `phase-02-auth/TD-08` (edição cross-doc em `docs/decisions/technical-decisions-phase-02-auth.md`, Decision A mantida, sem mudança de código):
  - O `ThrottlerGuard` registrado como `APP_GUARD` dentro do `AuthModule` vale para todas as rotas da aplicação.
  - Controllers fora de auth fazem opt-out com `@SkipThrottle()`; o primeiro caso é o `VideosController`, conforme `phase-03-videos/TD-10`.
- **ICC-2** _(resolved_by phase-03-videos/TD-03)_ — TD-03 (upload direto ao storage) vs BFF herdado: toda mutação em app/api/**. Opção (a), Revision 2026-11-04 em `phase-03-videos/TD-03` (Decision A mantida):
  - O plano de controle (iniciar upload, retomar, concluir, pedir URL de stream/download) passa pela API e, quando o frontend entrar, pelo BFF `app/api/**`, conforme `phase-02-auth-frontend/TD-05`.
  - O plano de dados (PUT das partes e GET da mídia) vai direto entre navegador e storage, nunca pelo BFF, para manter os bytes fora dos servidores.
  - A CORS do bucket (origem do frontend, métodos PUT/GET) será configurada na fase que trouxer o `next-frontend`.
- **AMB-9** _(resolved_by phase-03-videos/TD-08)_ — Stream/download: estado exigido do vídeo e TTL quando `duration_seconds` é nulo. Opção (a), Revision 2026-11-04 em `phase-03-videos/TD-08` (Decision A mantida):
  - `GET /videos/{publicId}/stream` e `GET /videos/{publicId}/download` só respondem `200 { url, expires_at }` com o vídeo em `ready`, o estado de sucesso de `phase-03-videos/TD-04`.
  - Em `draft`, `processing` ou `failed`, respondem `409` com o código de domínio `VIDEO_NOT_READY` no envelope herdado de `phase-02-auth/TD-07`.
  - Um vídeo `ready` cujo probing não informou `duration_seconds` usa o piso de 3600 s no TTL do stream.
  - A checagem de dono de `phase-03-videos/TD-09` vem antes: não-dono recebe `404 VIDEO_NOT_FOUND` em qualquer estado, sem revelar nada.
- **AMB-10** _(resolved_by phase-03-videos/TD-08)_ — Download: `Content-Disposition` e nome do arquivo baixado não definidos. Opção (a), Revision 2026-11-04 em `phase-03-videos/TD-08` (Decision A mantida):
  - A URL de download é assinada com `ResponseContentDisposition` = `attachment; filename="<fallback ASCII>"; filename*=UTF-8''<nome original percent-encoded>` (RFC 6266 / RFC 5987).
  - O nome usado é o nome original do arquivo declarado na iniciação de `phase-03-videos/TD-03`, persistido como `original_filename`.
  - A URL de stream não leva disposition e reproduz inline.

- **IC-1** _(resolved_by clarification)_ — Decisions Detail sem o texto das Revisions de TD-03/04/06/08 anunciadas no Index. Opção (a): `context.md` regenerado com `/plan-context 3`. O `decisions-detail-reader` trouxe todos os bullets `**Revisions:**` do decisions doc. Agora o `## Decisions Detail` tem os 8 bullets de 2026-11-04 (TD-02: 1; TD-03: 2; TD-04: 1; TD-06: 1; TD-08: 3), conferidos um a um contra o decisions doc, e o Index casa com o último bullet de cada TD.
- **AMB-11** _(resolved_by phase-03-videos/TD-03)_ — Conclusão: resposta HTTP quando o `HeadObject` pós-montagem diverge do declarado. Revision 2026-11-04 "Size mismatch outcome", gravada pelo usuário em `phase-03-videos/TD-03` (Decision A mantida):
  - `POST /videos/{publicId}/upload/complete` responde `409 UPLOAD_SIZE_MISMATCH` nas duas checagens de tamanho.
  - Na pré-checagem (tamanhos do `ListParts` × `file_size` declarado, antes do `CompleteMultipartUpload`), o vídeo continua `draft` e o cliente reenvia as partes problemáticas dentro da janela de upload.
  - Na reconferência pós-montagem (`HeadObject`), o objeto montado é apagado, o vídeo vira `failed` com `processing_error` `PROCESSING_FAILED` e o cliente precisa iniciar um novo upload. O `status` lido em `GET /videos/{publicId}` diz ao dono se o mesmo upload ainda tem conserto.
  - A Revision fecha a leitura (a) da issue: um único código para os dois casos. O "leave the video in `draft`" da Revision anterior vale só para a pré-checagem. `docs/phases/phase-03-videos/library-refs.md` (seção multipart de `@aws-sdk/client-s3`) foi ajustado: pré-checagem contra o tamanho declarado, `DeleteObjectCommand` no ramo pós-montagem e estado final `failed`.
- **AMB-12** _(resolved_by phase-03-videos/TD-02)_ — MinIO no Compose: imagem fixada e expiração de multipart não constam do context. Revisions 2026-11-04 gravadas pelo usuário em `phase-03-videos/TD-02` e `phase-03-videos/TD-12` (Decision A mantida nas duas):
  - TD-02, "MinIO image and buckets": `minio` e `minio-init` usam `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, que traz `mc` e `curl`. O `minio` tem healthcheck `curl -f http://localhost:9000/minio/health/live`. O `minio-init` é one-shot e cria os buckets `streamtube` (dev) e `streamtube-test` (testes) com `mc mb --ignore-existing`. Os serviços que usam o storage dependem dele com `condition: service_completed_successfully`.
  - TD-12, "MinIO stale-upload expiry": o serviço `minio` fixa `MINIO_API_STALE_UPLOADS_EXPIRY=24h`, igual à janela de upload de 24 h do TD-03.
  - Os bullets chegaram ao `## Decisions Detail` do `context.md`, e as linhas `└─ Last revision` de TD-02 e TD-12 no Index apontam para eles.
- **AMB-13** _(resolved_by phase-03-videos/TD-03)_ — Retry de complete após 503 QUEUE_UNAVAILABLE com o multipart já montado. Revision 2026-11-04 "Completion retry after an enqueue failure", gravada pelo usuário em `phase-03-videos/TD-03` (Decision A mantida):
  - `POST /videos/{publicId}/upload/complete` com o vídeo em `draft` e sem o multipart no storage confere o objeto com `HeadObject`. Se o objeto existe com o tamanho declarado, pula a montagem, move o vídeo para `processing`, enfileira e responde `202`. Se não há objeto, responde `410 UPLOAD_EXPIRED` e o vídeo vira `failed`.
  - No mesmo estado, `GET /videos/{publicId}/upload` responde `409 INVALID_VIDEO_STATE`, porque não há partes a reenviar.
  - Fica de pé o "so the client can retry" da Revision "Upload error contract": `503 QUEUE_UNAVAILABLE` pode ser repetido sem reenviar bytes.
  - `docs/phases/phase-03-videos/library-refs.md` foi ajustado. Na seção `bullmq` (producer fail-fast) entrou a repetição. Na seção multipart de `@aws-sdk/client-s3` entraram o ramo 5 (`HeadObject` → `202` ou `410`), o desempate da retomada (`409 INVALID_VIDEO_STATE`) e os nomes de erro (`NotFound` do HEAD; `NoSuchUpload`/404 do `ListParts`, a confirmar no MinIO). Os trechos de producer foram alinhados à Revision de TD-01: job `process-video`, `jobId` igual ao uuid do vídeo e prefixo padrão `streamtube`.
