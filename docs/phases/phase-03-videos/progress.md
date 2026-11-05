# phase-03-videos — Progress

**Status:** completed
**SIs:** 22/22 completed

### SI-03.1 — Infra: dependências e namespaces de config `storage` e `queue`
- **Status:** completed
- **Tests:** 13/13 passing (src/config/env.validation.integration-spec.ts)
- **Observations:**
  - `npm install` gravou no `package.json` as versões resolvidas como piso: `@nestjs/bullmq ^12.0.0`, `bullmq ^6.7.0`, `@aws-sdk/client-s3 ^3.1162.0` e `@aws-sdk/s3-request-presigner ^3.1162.0`. Todas caem dentro das faixas do plano (`^6.4.0`, `^3.1154.0`). Os `peerDependencies` do `@nestjs/bullmq@12.0.0` (`@nestjs/core ^10 || ^11 || ^12`, `bullmq ^3..^6`) batem com o `@nestjs/core 11.1.16` instalado.
  - **Desvio do plano:** a ação 4 pedia `Joi.string().uri()` em `S3_ENDPOINT` e `S3_PUBLIC_ENDPOINT`, mas esse validador aceita `minio:9000` como URI válida (RFC 3986: `minio` vira o esquema), o que contradiz o AC "`S3_ENDPOINT=minio:9000` é rejeitado". A implementação usa `Joi.string().uri({ scheme: ['http', 'https'] })`.
  - O `requiredEnv` da suíte de env ganhou `S3_ACCESS_KEY_ID` e `S3_SECRET_ACCESS_KEY`: sem eles, os testes existentes de `SWAGGER_ENABLED` falham pela nova chave obrigatória.
  - Linha de base antes da fase (unit + integration): 23 suítes e 145 testes.

### SI-03.2 — Infra: FFmpeg no `Dockerfile.dev` e variáveis novas no `.env.example`
- **Status:** completed
- **Tests:** no tests (Infra). ACs conferidos: `docker compose config` sai com 0 com `--env-file .env.example` e com o `.env`; após o rebuild, `ffprobe -version` e `ffmpeg -version` (5.1.9-0+deb12u1) saem com 0; `mail.from` lido do `.env.example` vale exatamente `"StreamTube" <noreply@streamtube.com>`; `src/mail/mail.service.integration-spec.ts` 5/5 passing
- **Observations:**
  - Os blocos `# Object Storage (MinIO)` e `# Queue (Redis + BullMQ)` foram replicados no `.env` local, que não é versionado. O `MAIL_FROM` do `.env` local já estava com aspas simples.
  - O `docker compose up -d --build` levou cerca de 15 min, quase todo no `apt install ffmpeg` (centenas de MB de dependências na `node:25.6.0-slim`). O `node_modules` fica no bind mount e sobrevive à recriação do container.

### SI-03.3 — Infra: serviços `redis`, `minio` e `minio-init` no Compose
- **Status:** completed
- **Tests:** no tests (Infra). ACs conferidos: `redis` e `minio` `healthy`, `minio-init` `Exited (0)`; `CONFIG GET maxmemory-policy` = `noeviction` e `appendonly` = `yes`; `mc ls local` lista `streamtube/` e `streamtube-test/`; um segundo `docker compose up -d` deixa o `minio-init` de novo em `Exited (0)`. O AC de `curl -f http://localhost:9000/minio/health/live` no host ficou **bloqueado pelo ambiente** (ver observações)
- **Observations:**
  - **AC bloqueado pelo ambiente do host:** o Zscaler Client Connector (`ZscalerTunnel`, `Proxy-Agent: Ztunnel/1.0`) intercepta `127.0.0.1:9000` no Mac e devolve resposta vazia (curl exit 52), com ou sem `--noproxy`. O MinIO está saudável: `curl http://minio:9000/minio/health/live` de dentro do `nestjs-api` responde `200`, e o console em `http://localhost:9001` responde `200` do host. Não é defeito do Compose, e a porta `9000:9000` do plano foi mantida. **Consequência para depois:** um cliente rodando no host com `S3_PUBLIC_ENDPOINT=http://localhost:9000` (override documentado no `.env.example`) também esbarra no Zscaler; vale decidir se o mapeamento no host deve usar outra porta. É uma decisão de plano, fora do escopo desta SI.
  - `docker compose up -d --build` refeito; o `nestjs-api` agora depende de `redis` (`service_healthy`) e de `minio-init` (`service_completed_successfully`).

### SI-03.4 — Infra de teste: `setup-test-env.ts` nos dois configs do Jest e helpers de isolamento
- **Status:** completed
- **Tests:** 10/10 passing (src/test/setup-test-env.spec.ts)
- **Observations:**
  - **Desvio do plano:** a ação 2 prescrevia `<rootDir>/src/test/setup-test-env.ts` no `test/jest-e2e.json` ("o `rootDir` é `.`"). No Jest, o `rootDir` relativo resolve a partir do diretório do arquivo de config, então `<rootDir>` é `/home/node/app/test`, e o caminho prescrito não existe: o Jest aborta com `Module ... in the setupFiles option was not found`, quebrando todo o e2e. Usei `<rootDir>/../src/test/setup-test-env.ts` e confirmei com `--showConfig` e com `test/app.e2e-spec.ts` passando.
  - O spec unitário também cobre as guardas de `emptyTestBucket()` (rejeita `S3_BUCKET=streamtube` sem chamar `S3Client.send`) e de `obliterateTestQueue()` (rejeita prefixo sem `test`; com prefixo de teste, chama `obliterate({ force: true })`), de modo que o AC da guarda fica coberto por teste.
  - ACs com I/O conferidos por um script avulso no `/tmp` do container, já removido: com 3 objetos e 1 multipart aberto em `streamtube-test`, depois de `emptyTestBucket()` sobram 0 objetos e 0 multipart (o `DeleteObjects` com checksum `WHEN_REQUIRED` funciona no MinIO). O `generateMediaFixtures()` gera as 6 fixtures em cerca de 3,4 s, num `mkdtemp` em `os.tmpdir()`: MP4 faststart, MP4 com moov no fim, `.mov` (h264/aac 1920x1080, 3 s), `.webm` (vp8/opus), `.m4a` só de áudio e 256 KiB aleatórios que o ffprobe rejeita. O `removeMediaFixtures()` apaga o diretório, e o `git status` não mostra arquivo de fixture.
  - Não existe paginator de `ListMultipartUploads` no SDK (só `ListObjectsV2`, `ListParts` e afins); o helper pagina por `NextKeyMarker`/`NextUploadIdMarker`.
  - Em `media-fixtures.ts` entrou também um `assertFfmpegAvailable()`, que falha cedo com mensagem de rebuild (testing guide § "Video Worker and FFmpeg": "Fail fast … when ffprobe is not available").

### SI-03.5 — Refactor: `ALL_ENTITIES` compartilhado nas suítes
- **Status:** completed
- **Tests:** no tests (refactor; as 11 suítes alteradas são o gate). `npm test` 164/164 passing em 24 suítes, a mesma contagem de antes do refactor (base de 145 + 9 da SI-03.1 + 10 da SI-03.4); `npm run test:e2e` 52/52 passing em 3 suítes
- **Observations:**
  - `grep -rn "const ALL_ENTITIES" src` encontra só `src/test/test-entities.ts`; nenhum `*.spec.ts`/`*.integration-spec.ts` passa lista literal ao `createTestDataSource` (11 chamadas, todas com `ALL_ENTITIES`).
  - Os imports de entidade que ficaram sem uso foram removidos de cada suíte. `auth.service.integration-spec.ts` e outras suítes que usam as entidades em repositórios ou queries mantêm os imports.
  - `src/database/migrations.integration-spec.ts` já tinha mudanças não commitadas antes desta fase (DROP num único statement e remoção dos tipos enum); a SI-03.5 tocou só o import e a lista.

### SI-03.6 — `ChannelsService.findByUserId`
- **Status:** completed
- **Tests:** 7/7 passing (src/channels/channels.service.integration-spec.ts; 3 novos em `findByUserId` + 4 existentes de `createChannel`)
- **Observations:**
  - `findByUserId` é leitura direta por `dataSource.getRepository(Channel).findOne`, fora de transação; o SAVEPOINT por tentativa do `createChannel` ficou intacto.
  - Os três casos cobertos: canal do usuário retornado, `null` para usuário sem canal e `null` para um uuid sem usuário (`randomUUID()`), sem erro.

### SI-03.7 — Entidade `Video`, relação `Channel.videos` e migration `CreateVideos`
- **Status:** completed
- **Tests:** 15/15 passing (src/videos/entities/video.entity.integration-spec.ts 7, src/channels/entities/channel.entity.integration-spec.ts 6, src/database/migrations.integration-spec.ts 2)
- **Observations:**
  - Migration gerada pelo CLI: `src/database/migrations/1793849825000-CreateVideos.ts`. O timestamp vem do relógio do container. Foi formatada com Prettier, igual às duas anteriores, e aplicada com `migration:run`. O SQL confere com o plano: `videos_status_enum` e `videos_processing_error_enum`, as 16 colunas, `UQ` em `public_id`, `IDX` em `channel_id`, FK `channel_id → channels(id)` com `NO ACTION` e `down()` simétrico com os dois `DROP TYPE`.
  - A migration foi gerada antes de rodar qualquer suíte com a entidade nova: as suítes de integração usam `synchronize: true` no mesmo banco de dev e teriam criado a tabela, deixando o `migration:generate` vazio.
  - `@PrimaryColumn('uuid')` segue o plano (o id é gerado no serviço antes do `CreateMultipartUpload`), apesar de a regra `nestjs-entities.md` sugerir `@PrimaryGeneratedColumn('uuid')`. Os enums `VideoStatus` e `VideoProcessingError` e a interface `VideoMetadata` ficam em `video.entity.ts`, no padrão de `VerificationTokenType`.
  - Além do que o plano pedia, o teste de revert confere que as outras quatro tabelas continuam e que os dois enums de `videos` somem, cobrindo o AC inteiro. Depois do `afterAll`, o banco de dev volta a ter as 3 migrations e os dois enums.
  - **Desvio do plano (achado no gate final do lote):** o plano só registrava o `Video` num `TypeOrmModule.forFeature` na SI-03.11, com o `VideosModule`. Com `autoLoadEntities: true`, a relação `Channel.videos` fazia o `AppModule` falhar no boot (`Entity metadata for Channel#videos was not found`), o que derrubava o `openapi-export.integration-spec.ts` (`process.exit(1)`) e os 3 e2e. As suítes de integração não pegaram o problema porque usam `ALL_ENTITIES`. Correção mínima, seguindo `nestjs-modules.md` (registrar a entidade no módulo dono assim que ela é criada): `src/videos/videos.module.ts` só com `imports: [TypeOrmModule.forFeature([Video])]`, registrado no `AppModule`. A SI-03.11 completa esse mesmo módulo (controller, service, `ChannelsModule`, `StorageModule`, `VideoProcessingProducerModule`) em vez de criá-lo.

### SI-03.8 — `StorageModule` e `StorageService` (dois `S3Client`, multipart e URLs pré-assinadas)
- **Status:** completed
- **Tests:** 22/22 passing (src/storage/storage.service.integration-spec.ts 9, src/storage/storage.service.spec.ts 11, src/storage/storage.module.spec.ts 2)
- **Observations:**
  - **Desvio do plano:** a ação 2 prescrevia `paginateListParts`, mas no MinIO real ele entra em loop infinito. O MinIO responde à listagem completa com `IsTruncated: false` e `NextPartNumberMarker: "0"`, e o paginator do SDK segue o token, sem olhar o `IsTruncated`, relistando as mesmas partes para sempre. Isso foi confirmado por script no container: mais de 5 páginas para 1 parte. O `listParts` pagina manualmente com `ListPartsCommand` e para quando `IsTruncated !== true`. Um teste unitário cobre a última página com marcador `"0"`.
  - Formatos de erro confirmados contra o MinIO real, por script no `/tmp` do container, já removido. Conexão recusada: `Error` com `code: 'ECONNREFUSED'` e `$metadata` sem `httpStatusCode`. `ListParts` de upload completado, abortado ou inexistente: `NoSuchUpload`, 404, o que confirma o "a confirmar" do plano. `HeadObject` de chave inexistente: `NotFound`, 404. Credencial inválida: `S3ServiceException`, 403. `DeleteObject` de chave inexistente e `AbortMultipartUpload` repetido respondem sucesso.
  - Regra de `StorageUnavailableException`: `httpStatusCode >= 500`, ou ausência de status com `$metadata` do SDK, código de rede (`ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT` etc.) ou nome `TimeoutError`/`RequestTimeout`. Os outros 4xx e os erros sem relação com o storage (ex.: `TypeError`) são relançados como estão. Nos métodos de leitura (`headObject`, `listParts`) e no `abortMultipartUpload`, o 404 vira `null`/no-op; nas escritas, o 404 é relançado.
  - Os tokens `S3_INTERNAL_CLIENT` e `S3_SIGNING_CLIENT` são `Symbol` em `src/storage/storage.constants.ts`. O `StorageModule` implementa `OnModuleDestroy` e chama `destroy()` nos dois clients, o que o module spec cobre.
  - O AC "com o `minio` parado → `503 STORAGE_UNAVAILABLE`" é coberto no integration spec com um `S3_INTERNAL_CLIENT` sobrescrito para `http://minio:1` (`ECONNREFUSED` real), sem parar o serviço compartilhado.
  - A `StorageUnavailableException` está em `src/storage/storage.exceptions.ts`, como manda o plano, e estende o `DomainException` de `src/common/exceptions/domain.exception.ts`.
  - O `StorageModule` ainda não é importado por nenhum módulo da aplicação: o primeiro consumidor é o `VideosModule` (SI-03.11).

### SI-03.9 — `QueueModule` e `VideoProcessingProducer`
- **Status:** completed
- **Tests:** 5/5 passing (src/queue/video-processing.producer.integration-spec.ts 3, src/queue/video-processing.producer.spec.ts 1, src/queue/video-processing-producer.module.spec.ts 1)
- **Observations:**
  - **Desvio (dependência faltando, herdada da SI-03.1):** no bullmq 6, o `ioredis` virou peer dependency **opcional** (`ioredis >=5.0.0`, `peerDependenciesMeta.optional`) e não vinha instalado. Qualquer `new Queue(...)` falhava com "BullMQ could not load the optional 'ioredis' package", na API e no worker, não só nos testes. Instalei `ioredis@^5.11.1`, a versão contra a qual o bullmq 6.7.0 é testado (o `devDependencies` dele), em vez da 6.0.0 recém-lançada.
  - **Desvio (infra de teste):** `@nestjs/bullmq` 12.0.0 e `@nestjs/bull-shared` 12.0.0 são ESM puro (`"type": "module"`). O runtime da aplicação não é afetado: o Node 25 faz `require(esm)`, o que foi confirmado com `node -e "require('@nestjs/bullmq')"` no container. Já o `require` próprio do Jest não carrega ESM (`SyntaxError: Unexpected token 'export'`). Nos dois configs (`package.json` → `jest` e `test/jest-e2e.json`), só esses dois pacotes passam a ser transformados para CJS: `transformIgnorePatterns: ["/node_modules/(?!@nestjs/(bullmq|bull-shared)/)"]` e uma regra de `transform` dedicada com `ts-jest` (`allowJs`, `module: commonjs`). Voltar para a 11.x exigiria `bullmq` ^5, contra o `phase-03-videos/TD-01`.
  - O merge do `@nestjs/bullmq` entre a config da raiz e a da fila é raso: o `connection` do `registerQueueAsync` substitui o da raiz, por isso repete `host`/`port`, enquanto `prefix` e `defaultJobOptions` vêm do `forRootAsync`. O module spec confere os dois lados. O `getQueueToken` é reexportado pelo `@nestjs/bullmq`, e o shutdown fecha a `Queue` (`onApplicationShutdown` → `close()`).
  - AC "Redis inacessível → rejeita na hora" conferido fora do Jest, por sonda no `/tmp` do container com um proxy TCP derrubado depois do `ready`: com o `ioredis` em `reconnecting`, o `add()` rejeita em 0–3 ms com "Stream isn't writeable and enableOfflineQueue options is false". **Caso de borda para follow-up:** um `add()` disparado no mesmo instante da queda, antes de o `ioredis` perceber o fechamento, fica pendente até a reconexão. Isso se observou com `docker compose stop/start redis` (um `add` levou 1032 ms e concluiu na volta) e no proxy (travou mais de 60 s sem reconexão). Limitar isso pede uma opção que o plano não prevê (ex.: `maxRetriesPerRequest` baixo na conexão do producer); fica para decisão.
  - O integration spec confere o prefixo de dev com um cliente `ioredis` só de leitura (`EXISTS`/`KEYS`). A primeira versão instanciava uma `Queue` com prefixo `streamtube`, e o bullmq grava o hash `streamtube:video-processing:meta` ao instanciar qualquer `Queue`, o que violava o próprio AC. A chave residual foi apagada, e o prefixo `streamtube:` ficou com 0 chaves depois da suíte. As chaves das sondas (`streamtube-test-probe:*`) também foram apagadas.
  - O `enqueue` loga o erro original (`Logger.error`) antes de lançar a `QueueUnavailableException`, para não perder a causa. A `QueueUnavailableException` fica em `src/queue/queue.exceptions.ts`, como manda o plano.

### SI-03.10 — Contratos de vídeo: constantes, `public_id`, exceções e DTOs
- **Status:** completed
- **Tests:** 14/14 passing (src/videos/public-id.util.spec.ts 7, src/videos/validators/matches-content-type-extension.validator.spec.ts 7)
- **Observations:**
  - `@MatchesContentTypeExtension()` é um decorator de classe que registra, via `registerDecorator`, a restrição `matchesContentTypeExtension` na propriedade `file_name`, para que o erro saia no campo certo do `400 VALIDATION_ERROR`. A comparação usa `path.extname(...).toLowerCase()`. Com um `content_type` fora da allowlist, o validador não acusa nada e deixa o erro só para o `@IsIn`, sem mensagem duplicada.
  - Além do que o plano pedia, para que todo AC fique observável em teste: o validator spec cobre também o `title` só com espaços (falha em `isLength` depois do trim) e o trim efetivo do título. O `public-id.util.spec.ts` cobre o `PublicIdParamDto`: aceita `AbCdEf_-123` e um id gerado, e rejeita `abc`, 12 chars, `+`/`/` e `=`. A fiação no `ValidationPipe` continua com os e2e das rotas.
  - Constantes extras derivadas do mapa do plano: `VideoContentType` (tipo) e `ALLOWED_VIDEO_CONTENT_TYPES`, que alimenta o `@IsIn` e evita repetir a lista. `CONTENT_TYPE_EXTENSIONS` é `as const`.
  - DTOs de resposta: `video-response.dto.ts` (`VideoResponseDto` + `VideoMetadataDto`), `upload-session-response.dto.ts` (`UploadSessionResponseDto` + `UploadPartUrlDto`), `upload-complete-response.dto.ts` e `media-url-response.dto.ts`. Todos os campos têm `@ApiProperty`; os nulláveis usam `type` explícito + `nullable: true`, e os enums usam `enumName` (`VideoStatus`, `VideoProcessingError`). As datas são `string` `format: date-time`, ficando o `toISOString()` para as SIs de rota.
  - As exceções de vídeo ficam em `src/videos/videos.exceptions.ts`, como manda o plano, estendem o `DomainException` comum e usam as mensagens do `### Error Catalog`.

### SI-03.11 — Endpoint POST /videos (pré-cadastro do rascunho e início do multipart)
- **Status:** completed
- **Tests:** 34/34 passing (src/videos/videos.service.spec.ts 13, src/videos/videos.service.integration-spec.ts 3, src/videos/videos.module.spec.ts 1, src/openapi-export.integration-spec.ts 9, test/videos-create.e2e-spec.ts 8)
- **Observations:**
  - O `VideosModule` mínimo da SI-03.7 foi completado (`ChannelsModule`, `StorageModule`, `VideoProcessingProducerModule`, controller e service), sem criar outro módulo. O `VideoProcessingProducer` só passa a ser injetado no `VideosService` na SI-03.14, onde é usado.
  - A chave do original sai de `src/videos/video-storage-keys.ts` (`originalKey(videoId)`), para o worker reaproveitar no lote 4.
  - O retry de `public_id` segue o `ChannelsService.createChannel`: até 5 novas tentativas (6 inserts no total) só na violação `23505` cujo `detail` cita `public_id`. O insert é fora de transação, então não precisa de SAVEPOINT. O helper que reconhece a violação foi duplicado localmente em vez de extraído do `channels.service.ts`, para não mexer em código de outra SI; extrair para `src/common` fica como follow-up.
  - O `abortMultipartUpload` depois de um insert falho é best-effort, como o plano pede: uma falha do abort é logada (`warn`) e o erro original do insert é relançado. O unit spec cobre os dois casos.
  - Usuário sem canal lança `Error` genérico (500). O plano não prevê o caso, e todo registro cria o canal.
  - O module spec confere a ausência de consumer percorrendo o `ModulesContainer` e procurando providers `instanceof WorkerHost`; hoje passa trivialmente, e no lote 4 passa a proteger contra o `VideoProcessingConsumer` vazar para a API.
  - Helpers de e2e extraídos para `test/utils/` porque se repetem nos 6 arquivos de vídeo: `e2e-app.ts` (`createE2eApp()` reproduzindo o `main.ts`, `bodyOf`), `auth.ts` (`registerConfirmAndLogin`, que devolve também o `id` do usuário) e `videos.ts` (`createVideo`, `putPart`, `videoRowOf`, `countVideos`, `expectSecondsFromNow`, `readVersionedOpenApi`). O `test/auth.e2e-spec.ts` não foi alterado.
  - `openapi.json` regenerado: `POST /videos` com 201/400/401/503, tag `videos` e security `access-token`. Já existente e fora do escopo: o `openapi:export` roda via `ts-node`, sem o plugin do Swagger, então os DTOs de request sem `@ApiProperty` (`RegisterDto`, `InitiateUploadDto`, …) saem com `properties: {}` no JSON versionado.
  - Com `--detectOpenHandles`, o Jest aponta um handle `CustomGC` da lib nativa `@css-inline/css-inline`, carregada pelo `HandlebarsAdapter` do mailer via `AppModule`. Não tem relação com vídeos; o processo termina normalmente.

### SI-03.12 — Endpoint GET /videos/{publicId} (status do vídeo, owner-only e lazy expiry)
- **Status:** completed
- **Tests:** 36/36 passing (src/videos/videos.service.spec.ts 24, dos quais 11 novos; src/videos/videos.service.integration-spec.ts 7, dos quais 4 novos; test/videos-get.e2e-spec.ts 5)
- **Observations:**
  - O controller chama um único `VideosService.getVideo(userId, publicId)`, que encadeia `findOwnedOrFail` → `expireIfDue` → `toVideoResponse`. O fluxo é o do plano, mas a orquestração fica no service, para o controller continuar fino (`nestjs-layer-separation.md`).
  - As transições de estado passam por um `transition(id, from, changes)` privado, que faz `UPDATE ... WHERE id = :id AND status = :from` via `repository.update` e devolve se alguma linha mudou. O `expireIfDue` só aborta o multipart quando a própria chamada fez a transição e sempre relê a linha, então devolve o estado real mesmo quando outro fluxo tirou o vídeo de `draft` antes. O integration spec cobre esse caso com uma cópia em memória desatualizada.
  - O `@ApiParam('publicId')` usa uma constante compartilhada no controller, com o padrão `^[A-Za-z0-9_-]{11}$`, que as outras quatro rotas reaproveitam.
  - O aviso `DeprecationWarning: Calling client.query() when the client is already executing a query` do `pg` aparece na suíte de integração e no module spec, que só compila o módulo com `synchronize: true`; não vem do código de vídeos.

### SI-03.13 — Endpoint GET /videos/{publicId}/upload (retomada do upload)
- **Status:** completed
- **Tests:** 43/43 passing (src/videos/videos.service.spec.ts 29, dos quais 5 novos; src/videos/videos.service.integration-spec.ts 9, dos quais 2 novos; test/videos-upload-resume.e2e-spec.ts 5)
- **Observations:**
  - **Ordem do spec × dependências:** o cenário 1.3 de `videos-upload-resume.plan.md` (`multipart-ja-montado-continua-draft-409`) usa `POST /videos/{publicId}/upload/complete`, que só existe na SI-03.14. Ele foi escrito na SI-03.14, na posição do spec, e os outros 5 cenários entraram aqui. O caso de serviço equivalente (`listParts` `null` + objeto presente → `InvalidVideoStateException`, vídeo continua `draft`) já está coberto no unit spec desta SI.
  - O helper privado `findOwnedForUpload` encadeia `findOwnedOrFail` → `expireIfDue` e lança `UploadExpiredException` quando a própria leitura acabou de levar o `draft` a `failed`/`UPLOAD_EXPIRED`. A SI-03.14 reaproveita o helper. Um vídeo que já estava `failed` antes da chamada cai no `409 INVALID_VIDEO_STATE` ("fora de `draft`"), como o plano descreve.
  - A transição `draft → failed`/`UPLOAD_EXPIRED` ficou num único `expireUpload(videoId)`, usado pela lazy expiry e pelo ramo "sem multipart e sem objeto".

### SI-03.14 — Endpoint POST /videos/{publicId}/upload/complete (conclusão e enfileiramento)
- **Status:** completed
- **Tests:** 67/67 passing (src/videos/videos.service.spec.ts 42, dos quais 13 novos; src/videos/videos.service.integration-spec.ts 11, dos quais 2 novos; test/videos-upload-complete.e2e-spec.ts 8; test/videos-upload-resume.e2e-spec.ts 6, com o cenário 1.3 adicionado nesta SI)
- **Observations:**
  - O cenário 1.3 de `videos-upload-resume.plan.md` (`multipart-ja-montado-continua-draft-409`), que depende desta rota, entrou nesta SI, na posição do spec. O arquivo de retomada agora cobre os 6 cenários.
  - O `VideoProcessingProducer` passou a ser injetado no `VideosService`. O `startProcessing` só reverte `processing → draft` quando a própria chamada fez a transição a partir de `draft`. Na conclusão repetida de um vídeo já em `processing`, uma falha do enqueue sobe como `503` e o vídeo continua em `processing`, sem voltar a `draft`. O plano não fixa esse caso, e voltar a `draft` deixaria o vídeo sem job nem upload a retomar.
  - A reconferência pós-montagem e o ramo do retry (`resolveAssembledObject`) usam o mesmo `verifyAssembledObject`: `HeadObject` com outro tamanho, ou sem objeto logo após o `CompleteMultipartUpload`, leva a `deleteObject` (idempotente), `failed`/`PROCESSING_FAILED` e `409 UPLOAD_SIZE_MISMATCH`.
  - As partes são ordenadas por `partNumber` antes da pré-checagem e do `CompleteMultipartUpload`, sem confiar na ordem devolvida pelo `ListParts`.
  - O teste de integração com duas partes envia 64 MiB + 1 KiB pelo MinIO real, como o e2e do spec (o tamanho da parte é fixo em 64 MiB). A 503 do enqueue é simulada com `jest.spyOn(queue, 'add').mockRejectedValueOnce(...)` na mesma `Queue` injetada no producer; o `ERROR [VideoProcessingProducer] Failed to enqueue ...` que aparece no log desses testes é o log esperado do producer.

### SI-03.15 — Endpoint GET /videos/{publicId}/stream (URL pré-assinada para streaming)
- **Status:** completed
- **Tests:** 23/23 passing (src/videos/media-url.util.spec.ts 5; src/videos/videos.service.integration-spec.ts 15, dos quais 4 novos; test/videos-stream.e2e-spec.ts 3)
- **Observations:**
  - **Cenários pendentes do lote 4 (dependem do worker, SI-03.17 a 03.20):** `videos-stream.plan.md` 1.1 `fluxo-ponta-a-ponta-ate-o-stream` e 2.2 `arquivo-invalido-termina-em-failed-unsupported-media` ficaram fora do arquivo, sem `skip`. No lote 4 entram também o worker in-process no `beforeAll` (`Test.createTestingModule({ imports: [WorkerModule] })`) e o helper `uploadAndProcess`, que passa a produzir o `V_ready` pelo fluxo real.
  - Neste lote, o `V_ready` dos cenários 1.2 e 1.3 vem de `seedReadyVideo` (`test/utils/videos.ts`): `POST /videos` real, o MP4 faststart de `generateMediaFixtures()` gravado em `videos/{id}/original` pelo `StorageService` e a linha marcada `ready` com `duration_seconds = 3`. O AC de `Range: bytes=0-1023` → `206` com 1024 bytes e sem `Content-Disposition` está coberto pelo integration spec, com um original gravado no MinIO real. O cenário 1.1 do e2e repete essa checagem pelo fluxo real no lote 4.
  - Os cenários 1.2, 1.3 e 2.1 seguem o Setup do spec: limpeza única e usuários e `V_ready` criados no `beforeAll`. O 1.2 restaura o `duration_seconds` num `finally`, para não vazar estado ao 1.3 se uma asserção falhar.
  - `assertReady` é privado no service. A ordem é `findOwnedOrFail` → `expireIfDue` → `assertReady`, e o integration spec cobre `draft`, `processing` e `failed` → `VideoNotReadyException`.
  - **Cenários pendentes concluídos no lote 4 (depois da SI-03.20):** 1.1 `fluxo-ponta-a-ponta-ate-o-stream` e 2.2 `arquivo-invalido-termina-em-failed-unsupported-media` entraram em `test/videos-stream.e2e-spec.ts`, nas posições do spec. O arquivo agora tem 5/5 passando. O `beforeAll` sobe o worker in-process (`startInProcessWorker()` em `test/utils/worker.ts`: `WorkerModule` + `init()`, com o prefixo `streamtube-test` e o backoff de 10 ms do setup), e o `V_ready` vem do fluxo real (`uploadAndProcess` em `test/utils/videos.ts`). O `seedReadyVideo` temporário foi removido. O 1.1 prova `duration_seconds` entre 2,5 e 3,5, as 7 chaves de `metadata`, `thumbnail_url` com GET 200 `image/jpeg`, `Range` → `206` com os 1024 primeiros bytes iguais aos da fixture, e só a URL de download levando `attachment`. O 2.2 envia bytes aleatórios como `video/mp4` e termina em `failed`/`UNSUPPORTED_MEDIA`, com stream `409 VIDEO_NOT_READY` para o dono e `404` para o outro. O `afterAll` fecha o worker antes do app; não há aviso de open handle nem "Jest did not exit".

### SI-03.16 — Endpoint GET /videos/{publicId}/download (URL pré-assinada com nome original)
- **Status:** completed
- **Tests:** 26/26 passing (src/videos/content-disposition.util.spec.ts 5; src/videos/videos.service.integration-spec.ts 17, dos quais 2 novos; test/videos-download.e2e-spec.ts 4)
- **Observations:**
  - **Cenários pendentes do lote 4 (dependem do worker):** `videos-download.plan.md` 1.1 `fluxo-ponta-a-ponta-ate-o-download` e 2.2 `arquivo-invalido-termina-em-failed-unsupported-media` ficaram fora do arquivo, sem `skip`. Como no stream, o `V_ready` (`Férias 2026.mp4`) vem por ora de `seedReadyVideo`, e o worker in-process e o `uploadAndProcess` entram no lote 4.
  - O AC de disposition (`Content-Disposition: attachment; filename="F_rias 2026.mp4"; filename*=UTF-8''F%C3%A9rias%202026.mp4` no GET da URL) está coberto pelo integration spec: GET real no MinIO, header comparado com `buildAttachmentDisposition('Férias 2026.mp4')` e corpo igual ao original. O unit spec fixa o valor literal do AC. O e2e 1.1 repete a checagem pelo fluxo real no lote 4, com o SHA-256 da fixture.
  - `buildAttachmentDisposition` troca por `_` cada **code point** fora de 0x20–0x7E (regex com flag `u`), então um emoji vira um único `_`, e não dois. Depois remove `"` e `\` do fallback e codifica `'`, `(`, `)` e `*` em `filename*`.
  - O e2e 3.1 confere no `openapi.json` versionado as 6 operações com a tag `videos`, todas com security `access-token`, e as respostas 200/400/401/404/409 do download.
  - **Cenários pendentes concluídos no lote 4 (depois da SI-03.20):** 1.1 `fluxo-ponta-a-ponta-ate-o-download` e 2.2 `arquivo-invalido-termina-em-failed-unsupported-media` entraram em `test/videos-download.e2e-spec.ts`, com o mesmo setup real do stream (worker in-process + `uploadAndProcess` com `Férias 2026.mp4`). O arquivo agora tem 6/6 passando. O 1.1 confere `title: "Férias 2026"`, metadados, thumbnail, `Range` → `206`, URL de download no host de `S3_PUBLIC_ENDPOINT` com TTL de 3600 s, `Content-Disposition` exatamente igual ao do AC, `Content-Length` e SHA-256 do corpo iguais aos da fixture. O 2.2 termina em `failed`/`UNSUPPORTED_MEDIA`, com `metadata`/`thumbnail_url` nulos e download `409 VIDEO_NOT_READY`.
  - **Gate do lote 3 (SI-03.11 a 03.16):** `npm test` 286/286 em 38 suítes; `npm run test:e2e` 86/86 em 9 suítes (52 da linha de base + 34 de vídeos), sem aviso de open handle nem "Jest did not exit"; `npx tsc --noEmit` e `npx eslint "{src,apps,libs,test}/**/*.ts"` (sem `--fix`) com exit 0; `npm run build` com exit 0; um segundo `npm run openapi:export` não altera o `openapi.json`.

### SI-03.17 — Runtime do worker: `src/worker/main.ts`, `WorkerModule` e build em `dist-worker`
- **Status:** completed
- **Tests:** 5/5 passing (src/worker/worker.module.spec.ts). ACs conferidos: `npm run build:worker` gera `dist-worker/worker/main.js` e mantém `dist/main.js`; `npm run build` em seguida gera `dist/main.js` sem nada de `dist-worker/` e mantém `dist-worker/worker/main.js`; `npx tsc --noEmit` sai com 0 com `dist-worker/` presente; `node dist-worker/worker/main` sobe, loga `Video worker started: queue "video-processing", prefix "streamtube", concurrency 1`, não abre porta (o único LISTEN do container é o DNS do Docker, `127.0.0.11`) e sai com 0 no `SIGTERM`; `git status` não lista `dist-worker/`
- **Observations:**
  - **Desvio do plano (entidades do `forFeature`):** com `autoLoadEntities`, o `TypeOrmModule.forFeature([Video])` prescrito derruba o boot do worker com `Entity metadata for Video#channel was not found`, e o `TypeOrmModule` fica repetindo a conexão (o Jest parece travado). O teste reproduziu o erro antes da correção. Correção mínima: `TypeOrmModule.forFeature([Video, Channel, User])` no `WorkerModule`, só as entidades que são alvo das relações (`Video → Channel ↔ User`), sem importar módulos da API.
  - **Desvio do plano (código de saída no `SIGTERM`):** o `app.enableShutdownHooks()` do Nest 11.1.16 roda os hooks e depois reenvia o sinal ao próprio processo (`process.kill(process.pid, signal)`), então o processo sai com 143, e não com o 0 do AC. O `main.ts` usa `app.enableShutdownHooks([], { useProcessExit: true })`, opção do próprio Nest que chama `process.exit(0)` depois dos hooks.
  - O shutdown do `@nestjs/bullmq` 12 foi conferido no código: o `BullExplorer.onApplicationShutdown` chama `worker.close()` em todos os workers, e cada `Queue` fecha workers e a si mesma no `onApplicationShutdown`. Por isso não há hook de encerramento próprio.
  - Para não duplicar a lista de namespaces e o schema, as opções do `ConfigModule.forRoot` foram extraídas para `src/config/config-module.options.ts` (`configModuleOptions`), usadas pelo `AppModule` e pelo `WorkerModule`. A factory do TypeORM está em `src/database/typeorm-options.ts`, como o plano pede. O `test/app.e2e-spec.ts` confirma que o `AppModule` refatorado sobe.
  - O script `start:worker:dev` prescrito aqui (`nest start --watch …`) foi trocado na SI-03.21, porque não encerrava de forma limpa no `SIGTERM` do Compose (ver a SI-03.21).
  - Os dois builds compilam o `src/` inteiro (mesmo codebase), então `dist/worker/` também existe no build da API e `dist-worker/main.js` no do worker. As saídas não se misturam: o `deleteOutDir` do `nest-cli.json` apaga só o `outDir` do tsconfig usado.

### SI-03.18 — `MediaProbeService`: extração de duração e metadados com `ffprobe`
- **Status:** completed
- **Tests:** 21/21 passing (src/worker/media/probe-parser.spec.ts 10, src/worker/media/media-probe.service.integration-spec.ts 7, src/worker/media/process-runner.integration-spec.ts 4)
- **Observations:**
  - Formato real conferido no container antes de escrever o parser: `format_name` do MP4 é `mov,mp4,m4a,3gp,3g2,mj2` e o do WebM é `matroska,webm`; `duration` e `bit_rate` vêm como string; o stream de áudio traz `avg_frame_rate: "0/0"`. Com bytes aleatórios, o ffprobe sai com 1 e `Invalid data found when processing input`. Com chave inexistente, sai com 1 e `Server returned 403 Forbidden` (o MinIO responde 403 ao GET assinado de chave ausente). **Nos dois casos, imprime `{}` no stdout**, que é o "JSON vazio" do plano: o service trata objeto vazio ou JSON ilegível como erro transitório (`MediaProcessingError`) antes de chamar o parser.
  - A allowlist compara os itens de `format_name` separados por vírgula com `mp4`/`mov`/`matroska`/`webm` (`ALLOWED_CONTAINER_FORMATS` em `src/worker/media/media.constants.ts`, junto com `MEDIA_PROCESS_TIMEOUT_MS = 120000`). Um stream de vídeo com `disposition.attached_pic = 1` (capa de um `.m4a`, que também é `mov,mp4,...`) não conta como vídeo; há um teste unitário extra para esse caso. Um stream de vídeo sem `width`/`height`/`codec_name` também é rejeitado como não suportado, porque essas três chaves não aceitam `null` no `VideoMetadata`.
  - `frame_rate` é arredondado em 2 casas (`30000/1001` → `29.97`), e `bit_rate` vira inteiro.
  - O `parseProbeOutput` recebe `unknown` e só lê campos depois de type guards (`isObject`, `stringOrNull`, `numericString` etc.), sem `as` sobre a saída do ffprobe.
  - Erros em `src/worker/media/media.errors.ts`: `UnsupportedMediaError` (sem retry) e `MediaProcessingError` (transitório). O `runProcess` lança `ProcessTimeoutError` no timeout, depois do `SIGKILL`, e o `spawn` roda com `shell: false` explícito.
  - Teste extra fora da tabela do plano: `process-runner.integration-spec.ts` (I/O real de processo) cobre stdout/stderr/código de saída, argumento com metacaracteres passado literalmente (sem shell), timeout com `SIGKILL` e binário inexistente (`ENOENT`).

### SI-03.19 — `ThumbnailService`: geração da thumbnail com `ffmpeg`
- **Status:** completed
- **Tests:** 10/10 passing (src/worker/media/thumbnail-time.util.spec.ts 5, src/worker/media/thumbnail.service.integration-spec.ts 5); `src/worker/worker.module.spec.ts` 5/5 com os dois providers registrados
- **Observations:**
  - Comportamento conferido no container antes de escrever o fallback: com `-ss` depois do fim do vídeo, o ffmpeg sai com **0 e stdout vazio** (nenhum erro). Por isso o fallback não olha só o código de saída: o resultado só é aceito com saída 0 e stdout começando pelo marcador JPEG `FF D8`. Caso contrário, com `t > 0`, repete em `t = 0`; se falhar também, lança `MediaProcessingError` (transitório). Timeout (`ProcessTimeoutError`) sobe direto, sem fallback.
  - O teste do fallback espiona o `runProcess` (`jest.spyOn` no módulo) e confere os dois `-ss` (`5` e depois `0`), além de comparar os bytes com a thumbnail gerada em `t = 0`. O `testsrc` muda a cada frame, então a igualdade prova que o frame veio de `t = 0`.
  - A fixture mais estreita que 1280 px (640x360, 2 s) é gerada no próprio `beforeAll`, dentro do diretório temporário das fixtures de `media-fixtures.ts`. O `media-fixtures.ts` só tem fixtures de 1920x1080.
  - A chave sai de `thumbnailKey(videoId)`, novo em `src/videos/video-storage-keys.ts`, ao lado do `originalKey`. O `HeadObject` confere `ContentType: image/jpeg` e `ContentLength` igual ao buffer.

### SI-03.20 — `VideoProcessingConsumer`: job `process-video`, `UnrecoverableError` e `@OnWorkerEvent('failed')`
- **Status:** completed
- **Tests:** 31/31 passing (src/worker/video-processing.consumer.spec.ts 18, src/worker/video-processing.consumer.integration-spec.ts 6, src/worker/worker.module.spec.ts 6, src/videos/videos.module.spec.ts 1), sem aviso de open handle nem "Jest did not exit"
- **Observations:**
  - **Job travado (stall), conferido no código do bullmq 6.7.0:** um job que passa do `maxStalledCount` recebe no Lua (`moveStalledJobsToWait`) o campo `deferredFailure = "job stalled more than allowable limit"` e volta para `wait`. O próximo worker que o pega chama `handleFailed` com `new UnrecoverableError(...)` e emite `failed`. A regra do plano (`error instanceof UnrecoverableError` → falha definitiva; mensagem diferente de `UNSUPPORTED_MEDIA` → `PROCESSING_FAILED`) cobre o stall sem caso especial, e há um teste unitário para essa mensagem. O `attemptsMade` já vem incrementado quando o evento dispara (`job.moveToFailed` antes do `emit`).
  - A URL interna do original é assinada duas vezes, logo antes do ffprobe e logo antes do ffmpeg, com `originalKey(video.id)` (não existe coluna `original_key`; a chave é derivada do id, como na API). O motivo de rejeição (`UnsupportedMediaError.message`) é logado antes do `UnrecoverableError('UNSUPPORTED_MEDIA')`.
  - A comparação `error.message === VideoProcessingError.UNSUPPORTED_MEDIA` usa `(… as string)` por causa do lint `no-unsafe-enum-comparison`.
  - Além da tabela do plano, o integration spec cobre os ACs "job para vídeo já `ready` termina sem alterar a linha" (linha idêntica antes e depois, sem thumbnail no storage), "vídeo inexistente → job concluído" e "`VIDEO_WORKER_CONCURRENCY=2` processa dois jobs ao mesmo tempo". Neste último, o `probe` é segurado até haver dois em execução e devolve um resultado fixo; a thumbnail roda de verdade. O caso confere `consumer.worker.concurrency === 2` e pico de 2 jobs ativos.
  - O worker in-process do integration spec sobe com `Test.createTestingModule({ imports: [WorkerModule] }).compile()` + `moduleRef.init()`; o `compile()` sozinho não chama `onModuleInit`, então o module spec não cria worker nem consome jobs.
  - O AC "`GET /videos/{publicId}` retorna `ready` e `thumbnail_url` não nulo" fica coberto pelos cenários 1.1 de `videos-stream`/`videos-download`, escritos logo depois desta SI.

### SI-03.21 — Infra: serviço `video-worker` no Compose
- **Status:** completed
- **Tests:** 1/1 passing (test/video-worker.e2e-spec.ts). Com o `video-worker` parado, o mesmo teste falha (`Expected: >= 1, Received: 0`), o que confirma que ele mede o container. ACs conferidos: depois de `docker compose up -d`, o `video-worker` fica `Up` sem nenhum `exec` manual (a imagem `nestjs-project-video-worker` saiu do cache do `Dockerfile.dev`, que não tem `COPY`); o log mostra `Video worker started: queue "video-processing", prefix "streamtube", concurrency 1`; `docker compose stop video-worker` termina em menos de 1 s com `ExitCode 0`, e `docker compose restart video-worker` volta a `Up`; um vídeo concluído pelo `VideosService` real em dev (banco de dev, bucket `streamtube`, prefixo `streamtube`) chegou a `ready` em cerca de 500 ms, com `duration_seconds`, as 7 chaves de `metadata` e `thumbnail_url`, sem processo iniciado à mão. O script ficou no `/tmp` do container e foi apagado; os dados de dev criados (usuário, canal, vídeo e os dois objetos) também foram removidos
- **Observations:**
  - **Desvio do plano (script `start:worker:dev`, criado na SI-03.17):** com `nest start --watch`, o `SIGTERM` do Compose não encerrava o worker de forma limpa. A cadeia era `npm (PID 1) → sh → nest CLI → app`. O npm repassa o sinal só ao filho direto (`sh`), e o Nest CLI 11.0.16 não trata `SIGTERM` (o `treeKillSync` dele só roda no evento `exit`, que não acontece em morte por sinal). Resultado: o npm saía com `command failed / signal SIGTERM` (`ExitCode 1`), e o app era morto pelo kernel junto com o PID 1, sem rodar os hooks de shutdown nem fechar o worker do BullMQ. Correção mínima, mantendo o `command: ["npm", "run", "start:worker:dev"]` do plano: o script passou a `nest build --path tsconfig.worker.json && (tsc -p tsconfig.worker.json --watch --preserveWatchOutput &) && exec node --enable-source-maps --watch dist-worker/worker/main`. O `node --watch` vira o filho direto do npm (via `exec`), repassa o `SIGTERM` ao app e espera ele terminar. Isso foi conferido num teste isolado: limpeza de 1,5 s concluída e saída 0. O app roda os hooks (`useProcessExit` da SI-03.17) e sai com 0. O build inicial usa o `nest build` (plugins e `deleteOutDir`), e a recompilação em background usa `tsc --watch`, que não apaga o `dist-worker/` enquanto o `node --watch` o observa. A saída continua em `dist-worker/`, e o `dist/` da API fica intacto: `npm run build` depois do worker em watch mantém `dist-worker/worker/main.js`, e o `dist/main.js` continua lá.
  - Árvore de processos no container: `npm run start:worker:dev` (PID 1) → `node --watch` → app, mais o `tsc --watch` (reparentado ao PID 1). Num `npm run build:worker` disparado de fora durante o watch, o `deleteOutDir` apaga o `dist-worker/` e o `node --watch` reinicia o app quando os arquivos voltam; é comportamento de dev, sem efeito na API.
  - O e2e de liveness usa `queueConfig()` só para host e porta e monta a `Queue` com o prefixo de dev explícito (`streamtube`), já que o setup de teste força `streamtube-test`. Ele só chama `getWorkers()` e fecha a fila no `finally`.
  - A seção "Videos" e os comandos de prontidão do `video-worker` no `nestjs-project/CLAUDE.md` ficam para a SI-03.22 (documentação), fora deste lote.
  - **Gate do lote 4 (SI-03.17 a 03.21 + cenários pendentes do lote 3):** `npm test` 347/347 em 46 suítes; `npm run test:e2e` 91/91 em 10 suítes, com o `video-worker` em execução (86 do lote 3 + 2 de stream + 2 de download + 1 de liveness); nenhum aviso de "Jest did not exit" nem de open handles; `npx tsc --noEmit`, `npm run lint` e `npm run build` com exit 0; depois do gate, `dist/main.js` e `dist-worker/worker/main.js` coexistem e o `video-worker` segue `Up`.

### SI-03.22 — Documentação: CLAUDE.md, README e diagrama de arquitetura
- **Status:** completed
- **Tests:** no tests (documentação). ACs conferidos: `grep -n "TBD" CLAUDE.md docs/diagrams/software-arch.mermaid` e `grep -n "not yet initialized" CLAUDE.md` sem resultado; `README.md` sem nenhum "planejado"; `nestjs-project/CLAUDE.md` lista `redis`, `minio`, `minio-init` e `video-worker`, cada um com comando de prontidão (rodados no ambiente: `PONG`, MinIO `200` pela rede Docker, `minio-init` `Exited (0)`, log `Video worker started: queue "video-processing", prefix "streamtube", concurrency 1`); `software-arch.mermaid` validado como C4 sem erro de sintaxe, com a fila "Redis + BullMQ". Grep cruzado: as 6 rotas citadas (docs e `api.http`) batem com o `VideosController`; os 14 scripts `npm run` citados existem no `package.json` do subprojeto correspondente; os 8 serviços citados existem no `compose.yaml` (o `next-frontend` no do frontend); as 16 variáveis de ambiente citadas estão no `.env.example`, no `compose.yaml` (`MINIO_API_STALE_UPLOADS_EXPIRY`) ou no `env.validation.ts`; os códigos de erro citados existem nas exceções; todo arquivo citado existe
- **Observations:**
  - Documentos alterados: `nestjs-project/CLAUDE.md` (prontidão por serviço, exceção do `video-worker`, os 7 serviços com portas, rebuild do Dockerfile, restart do worker após `npm install`, scripts do worker, seção "Videos (Phase 03)", Jest Configuration com `setup-test-env.ts` e o `transform`/`transformIgnorePatterns` do `@nestjs/bullmq`, exemplo de `MAIL_FROM` com aspas simples), `CLAUDE.md` da raiz (fila Redis + BullMQ, worker no mesmo codebase, plano de controle × plano de dados, `next-frontend/` existente), `README.md` da raiz (arquitetura, serviços, seção "Vídeos (Fase 03)", árvore, fases e stack), `docs/diagrams/software-arch.mermaid` e `nestjs-project/api.http` (rotas 10 a 16 de vídeos).
  - **Desvio do plano:** a ação 1 prescrevia `docker compose ps minio-init` → `exited (0)`, mas o `docker compose ps` sem `-a` não lista containers encerrados (sai vazio). O doc usa `docker compose ps -a minio-init`.
  - **Desvio do plano (ambiente):** a checagem do MinIO ficou documentada pela rede Docker (`docker compose exec nestjs-api curl -f http://minio:9000/minio/health/live`), com o `curl -f http://localhost:9000/minio/health/live` do plano como equivalente no host e a nota do proxy corporativo que intercepta `localhost:9000` (observação da SI-03.3).
  - **Desvio do plano (diagrama):** as relações seguem o pedido do lote: `Rel(frontend, storage, "Uploads parts / Streams (presigned URLs)", "HTTPS")` e `Rel(api, storage, "Presigns, completes uploads")`, em vez de `"Uploads parts / Streams"` e `"Signs URLs, multipart control"` do plano; o sentido (API fora do caminho dos bytes, TD-03/TD-08) é o mesmo.
  - O `redis` não publica porta no host (só `6379` na rede Docker), e os docs dizem isso; o plano não pedia porta publicada.

## Final verification

Rodada em 2026-11-05, dentro do container (`docker compose exec -T nestjs-api ...`), com o `video-worker` em execução.

| Check | Comando | Resultado |
|-------|---------|-----------|
| Unit + integration | `npm test` | 46/46 suítes, 347/347 testes, exit 0 (96 s) |
| E2E | `npm run test:e2e` | 10/10 suítes, 91/91 testes, exit 0 (64 s), incluindo `test/video-worker.e2e-spec.ts`; sem "Jest did not exit" nem open handles |
| Type-check | `npx tsc --noEmit` | exit 0, sem saída |
| Lint | `npm run lint` | exit 0; o hash dos `.ts` de `src/` e `test/` é o mesmo antes e depois do `--fix`, e o `git diff --stat` do subprojeto não mudou (35 arquivos, +2393/−271) |
| Build da API | `npm run build` | exit 0, `dist/main.js` gerado |
| Build do worker | `npm run build:worker` | exit 0, `dist-worker/worker/main.js` gerado, `dist/main.js` mantido |
| OpenAPI | `npm run openapi:export` | exit 0; `openapi.json` com o mesmo md5 antes e depois, sem diff novo |

Phase deliverables, cobertos pelos e2e: upload multipart direto ao storage com partes de 64 MiB e limite de 10 GiB (`videos-create`, `videos-upload-resume`, `videos-upload-complete`); processamento automático até `ready`, com duração, metadados e thumbnail (cenários 1.1 de `videos-stream`/`videos-download` com o worker in-process, e o `video-worker` do Compose conectado à fila de dev); streaming com `Range` → `206` (`videos-stream` 1.1); `public_id` de 11 caracteres base64url em todas as rotas (`videos-create`, `videos-get`).

**Observação da final verification:**
- O `npm run build:worker` (com `deleteOutDir`) apagou o `dist-worker/` que o `video-worker` em watch observava. Ao contrário do que a SI-03.21 registrou, o `node --watch` não reiniciou quando os arquivos voltaram: ficou em `Cannot find module '/home/node/app/dist-worker/worker/main'` / `Waiting for file changes before restarting...`. Um `docker compose restart video-worker` resolveu (log `Video worker started: queue "video-processing", prefix "streamtube", concurrency 1`), e o `nestjs-project/CLAUDE.md` passou a documentar esse restart. Não afeta a API nem os testes.

**Follow-ups fora do escopo (reproduzidos das SIs):**
- SI-03.3: **Consequência para depois:** um cliente rodando no host com `S3_PUBLIC_ENDPOINT=http://localhost:9000` (override documentado no `.env.example`) também esbarra no Zscaler; vale decidir se o mapeamento no host deve usar outra porta. É uma decisão de plano, fora do escopo desta SI.
- SI-03.9: **Caso de borda para follow-up:** um `add()` disparado no mesmo instante da queda, antes de o `ioredis` perceber o fechamento, fica pendente até a reconexão. Isso se observou com `docker compose stop/start redis` (um `add` levou 1032 ms e concluiu na volta) e no proxy (travou mais de 60 s sem reconexão). Limitar isso pede uma opção que o plano não prevê (ex.: `maxRetriesPerRequest` baixo na conexão do producer); fica para decisão.
- SI-03.11: O helper que reconhece a violação foi duplicado localmente em vez de extraído do `channels.service.ts`, para não mexer em código de outra SI; extrair para `src/common` fica como follow-up.
- SI-03.11: Usuário sem canal lança `Error` genérico (500). O plano não prevê o caso, e todo registro cria o canal.
- SI-03.11: Já existente e fora do escopo: o `openapi:export` roda via `ts-node`, sem o plugin do Swagger, então os DTOs de request sem `@ApiProperty` (`RegisterDto`, `InitiateUploadDto`, …) saem com `properties: {}` no JSON versionado.
- SI-03.11: Com `--detectOpenHandles`, o Jest aponta um handle `CustomGC` da lib nativa `@css-inline/css-inline`, carregada pelo `HandlebarsAdapter` do mailer via `AppModule`. Não tem relação com vídeos; o processo termina normalmente.
- SI-03.12: O aviso `DeprecationWarning: Calling client.query() when the client is already executing a query` do `pg` aparece na suíte de integração e no module spec, que só compila o módulo com `synchronize: true`; não vem do código de vídeos.

### Code review fixes

Correções de um code review da fase, rodadas em 2026-11-05. Cada item tem teste no nível do que mudou.

1. **`startProcessing` ignorava o resultado da transição `draft → processing`.**
   - **O que mudou:** se o `UPDATE ... WHERE status = 'draft'` não afeta linha, o `VideosService` não enfileira às cegas. Ele relê o vídeo e responde pelo estado real: `failed`/`UPLOAD_EXPIRED` → `410 UPLOAD_EXPIRED`; `processing` → re-enqueue com o mesmo `jobId` e `202`, sem reverter para `draft` se esse re-enqueue falhar, porque não foi esta requisição que mudou a linha; qualquer outro estado → `409 INVALID_VIDEO_STATE`.
   - **Testes:** unit (`videos.service.spec.ts`, 6 casos de transição perdida). Integration (`videos.service.integration-spec.ts`, 2 casos com Postgres, MinIO e Redis reais): o `HeadObject` é espionado e altera a linha no meio do fluxo, simulando outra requisição. Com a linha em `processing`, a resposta é `202` e o job existe. Com `failed`/`UPLOAD_EXPIRED`, a resposta é `410`, sem job.
2. **Expiração tardia não apaga o original montado.**
   - **O que mudou:** o comportamento não mudou, por decisão: pela `phase-03-videos/TD-12`, os originais de vídeos `failed` ficam retidos, e a remoção é uma ação de gerenciamento da Fase 04.
   - **Documentação:** isso não estava escrito na seção "Videos (Phase 03)" do `nestjs-project/CLAUDE.md` e foi acrescentado em "Status lifecycle".
3. **`findOwnedForUpload` só respondia `410` quando a própria requisição expirava o vídeo.**
   - **O que mudou:** agora qualquer vídeo `failed` com `processing_error = UPLOAD_EXPIRED` responde `410 UPLOAD_EXPIRED` em `GET .../upload` e em `POST .../upload/complete`, sem comparar o estado antes e depois. Antes, um vídeo expirado por outra requisição respondia `409 INVALID_VIDEO_STATE`. Um `failed` por outro motivo continua `409`.
   - **Testes:** unit (2 casos por rota) e e2e `video-ja-expirado-por-outra-requisicao-410`, em `videos-upload-resume` e em `videos-upload-complete`. Os dois expiram o vídeo por `GET /videos/{publicId}` e depois chamam a rota de upload.
4. **`listParts` e `headObject` tratavam qualquer 404 como "não existe".**
   - **O que mudou:** a decisão agora usa o nome do erro do SDK. Viram `null` só `NoSuchUpload` (`ListParts`) e `NotFound`/`NoSuchKey` (`HeadObject`). `NoSuchBucket`, qualquer outro 404 dessas leituras, 5xx e erros de rede viram `STORAGE_UNAVAILABLE` (503).
   - **Conferido contra o MinIO real:**
     - O 404 do HEAD vem sem corpo, então o SDK nomeia `NotFound` tanto para chave inexistente quanto para bucket inexistente. O MinIO só distingue pelo header `x-minio-error-code`, que é específico do fornecedor. Por isso o `NotFound` do `HeadObject` é confirmado com um `HeadBucket`, que só roda nesse caminho: bucket presente → `null`; bucket ausente → `STORAGE_UNAVAILABLE`.
     - O `ListParts` num bucket inexistente responde `NoSuchBucket` quando recebe um `UploadId` real. Com um id inventado, o MinIO valida o id antes do bucket e responde `NoSuchUpload`.
     - O mesmo critério passou a valer para o `AbortMultipartUpload`, que também ignorava qualquer 404: só `NoSuchUpload` é ignorado, e `NoSuchBucket` vira `STORAGE_UNAVAILABLE`. A mudança era necessária para o item 10.
   - **Testes:** unit (`storage.service.spec.ts`). Integration (`storage.service.integration-spec.ts`, describe `missing bucket`): um `StorageService` com o bucket `streamtube-test-missing-bucket` cobre `headObject`, `listParts` (com `UploadId` real) e `abortMultipartUpload`.
5. **Job falho retido no Redis tornava o re-enqueue um no-op.**
   - **O que mudou:** o `VideoProcessingProducer.enqueue` faz `getJob(videoId)` antes do `add`. Um job `waiting`, `active`, `delayed`, `prioritized` ou `waiting-children` é mantido, e a chamada fica idempotente. Um job `failed` ou `completed` é removido e adicionado de novo. Assim, um `complete` repetido recupera um vídeo que ficou em `processing` porque o `onFailed` não gravou `FAILED`. O consumer não mudou.
   - **Testes:** unit (`video-processing.producer.spec.ts`, estados e ordem `remove` → `add`). Integration com Redis real em dois arquivos:
     - `video-processing.producer.integration-spec.ts`: um `Worker` de teste falha o job com `UnrecoverableError`, e o novo `enqueue` deixa um job `waiting` com `attemptsMade = 0`. Um job `completed` retido é substituído, e um job `delayed` é mantido.
     - `videos.service.integration-spec.ts`: depois do `complete`, o worker de teste falha o job sem tocar no banco. Um segundo `complete` responde `202` e deixa o job `waiting`.
6. **Tamanho das partes não era validado antes do `CompleteMultipartUpload`.**
   - **O que mudou:**
     - Pré-checagem: todas as partes, exceto a última, precisam ter exatamente `upload_part_size` (64 MiB), e a última, no máximo isso. Uma divergência responde `409 UPLOAD_SIZE_MISMATCH` com o vídeo em `draft`, seguindo a Revision "Size mismatch outcome" do TD-03. Antes, partes `[5 MiB, 59 MiB + 1 KiB]` com o total certo eram montadas e aceitas.
     - Rejeições do storage: o `StorageService` mapeia `EntityTooSmall`, `InvalidPart` e `InvalidPartOrder` do `CompleteMultipartUpload` (400 no MinIO, conferido) para `MultipartUploadRejectedException`, em `src/storage/storage.exceptions.ts`, que o `VideosService` traduz em `409 UPLOAD_INCOMPLETE`, também com o vídeo em `draft`.
     - A checagem "última parte ≤ `part_size`" é redundante com a contagem de partes: uma última parte maior faria o total exigir mais uma parte, e a contiguidade já responde `UPLOAD_INCOMPLETE`. Ela foi mantida porque expressa a regra.
   - **Testes:**
     - Unit: partes fora do tamanho, última parte menor e igual, rejeição do storage, e 5xx na montagem continuando `STORAGE_UNAVAILABLE`.
     - Integration do storage: os 3 códigos gerados de verdade no MinIO.
     - Integration do service: partes `[5 MiB, resto]` → `UPLOAD_SIZE_MISMATCH`, com as partes ainda listadas. Um ETag obsoleto gera `InvalidPart` real → `UPLOAD_INCOMPLETE`.
     - E2E `partes-fora-do-part-size-409-upload-size-mismatch`. Depois do item 12 da revisão de segurança, o storage barra essas partes no PUT, e o cenário virou `partes-fora-do-part-size-recusadas-pelo-storage-409-upload-incomplete`.
7. **`add()` pendurado com o Redis fora no boot.**
   - **O que mudou:**
     - O `enqueue` inteiro (`getJob`, `remove` e `add`) passa por um `Promise.race` com timeout configurável: `QUEUE_ENQUEUE_TIMEOUT_MS`, default 5000 no Joi e no `queue.config.ts` (`enqueueTimeoutMs`), adicionado ao `.env.example` e ao `.env`.
     - O timer é limpo no `finally`. Uma rejeição tardia do `add` fica tratada pelo próprio `Promise.race`.
     - Estourar o limite lança `QueueUnavailableException`, que reverte o vídeo para `draft` e responde `503`.
     - Achado no teste: uma `Queue` cuja conexão nunca ficou pronta precisa de `close()`, que derruba a conexão em `initializing`. O `disconnect()` espera a conexão e pendura o Jest.
   - **Testes:**
     - Unit com fake timers: um `add` que nunca resolve rejeita em exatamente 5000 ms, sem timer pendente depois. No caminho feliz, o timer também é limpo.
     - Integration: uma `Queue` apontada para `redis.invalid` com timeout de 300 ms rejeita com `QueueUnavailableException` em menos de 1,3 s.
     - `env.validation.integration-spec.ts`: default 5000 e rejeição de valor `0`.
   - Isso também resolve o caso de borda registrado como follow-up na SI-03.9 (`add()` pendente até a reconexão).
8. **Helper de unique violation duplicado.**
   - **O que mudou:** a detecção foi extraída para `src/database/pg-errors.ts`, com o type guard `isPgQueryFailedError` e `isUniqueViolation(err, { column?, constraint? })`. O helper casa a coluna pelo prefixo `Key (<coluna>)=` do `detail`, o que o deixa mais estrito que o `includes` anterior, ou o nome da constraint. `channels.service.ts`, que mantém o SAVEPOINT, e `videos.service.ts` passaram a usar o helper. Isso fecha o follow-up da SI-03.11.
   - **Testes:** unit `src/database/pg-errors.spec.ts`, com 9 casos, entre eles uma coluna cujo nome só contém o alvo, outro código Postgres e um erro que não é `QueryFailedError`. As suítes de `ChannelsService` e `VideosService` continuam verdes.
9. **`initiateUpload` lançava `Error` genérico (500) para usuário sem canal.**
   - **Decisão:** nova `ChannelNotFoundException` (`CHANNEL_NOT_FOUND`, 404, "Channel not found") em `src/channels/channels.exceptions.ts`, uma `DomainException` mapeada pelo `DomainExceptionFilter` global.
   - **Por quê:**
     - O caso só ocorre com uma conta inconsistente, já que todo registro cria o canal.
     - O 404 descreve o recurso que falta sem expor detalhes internos.
     - Nada é aberto no storage antes da checagem.
     - Fecha o follow-up da SI-03.11.
   - **Contrato:** `@ApiResponse(404)` em `POST /videos` e `openapi.json` regenerado.
   - **Testes:** unit no service e no filtro. E2E `usuario-sem-canal-404-channel-not-found`: apaga o canal, confere o envelope, confere que não houve chamada ao S3 nem linha criada, e a asserção de OpenAPI passou a incluir o `404`.
10. **`abortUploadBestEffort` engolia o erro no ciclo de requisição.**
    - **O que mudou:** o helper foi removido.
      - Na compensação do `initiateUpload`, quando o insert falha, o abort é tentado. Se o abort também falhar, o erro é registrado com `logger.error` e o **erro original do insert** é relançado, sem ser mascarado.
      - Na lazy expiry, o vídeo já é marcado `failed`/`UPLOAD_EXPIRED` antes do abort. O erro do abort agora propaga, mapeado pelo `StorageService` para `STORAGE_UNAVAILABLE`: rede, 5xx e `NoSuchBucket`, conforme o item 4.
    - **Contrato:** como a lazy expiry roda em `GET /videos/{publicId}`, `/stream`, `/download` e nas rotas de upload, essas rotas agora podem responder `503 STORAGE_UNAVAILABLE`. O `@ApiResponse(503)` foi acrescentado a `GET /videos/{publicId}`, `/stream` e `/download`, e as descrições de `GET .../upload` e `POST .../upload/complete` foram ajustadas. O `openapi.json` foi regenerado.
    - **Testes:**
      - Unit: a ordem é `update` e depois `abort`, e o erro propaga; na compensação, o erro do insert é relançado e o log é feito.
      - Integration com MinIO real: a compensação aborta de fato (`listParts` → `null`) e não deixa linha; com o abort também falhando, sobe o erro do insert e o upload fica para a expiração de 24 h do storage. Com o abort falhando na expiry, a linha fica `failed`/`UPLOAD_EXPIRED` e a próxima retomada responde `410`.
      - E2E `lazy-expiry-com-storage-fora-503-e-video-ja-failed`: `503` no primeiro `GET`, e `200 failed` no seguinte.

11. **`NoSuchUpload` no próprio `CompleteMultipartUpload` saía como 500.**
    - **Causa:** dois `complete` simultâneos do mesmo vídeo listam as mesmas partes. O primeiro consome o upload, e o `CompleteMultipartUpload` do segundo recebe `NoSuchUpload`, que o `StorageService` repassava como erro bruto.
    - **O que mudou:**
      - O `StorageService` traduz o `NoSuchUpload` do `CompleteMultipartUpload` em `MultipartUploadMissingException`, em `src/storage/storage.exceptions.ts`, no mesmo padrão da `MultipartUploadRejectedException`.
      - O `VideosService` trata essa exceção pelo caminho da Revision "Completion retry after an enqueue failure" do TD-03: `HeadObject` do original. Objeto com o tamanho declarado → `startProcessing`, que já é idempotente: faz `draft → processing` e enfileira, ou, se a outra chamada já fez a transição, re-enfileira com o mesmo `jobId` e responde `202`. Sem objeto → `failed`/`UPLOAD_EXPIRED` e `410 UPLOAD_EXPIRED`.
    - **Contrato:** nenhum código novo, porque `202` e `410` já estavam documentados na rota. A descrição de `POST /videos/{publicId}/upload/complete` passou a citar chamadas concorrentes, e o `openapi.json` foi regenerado.
    - **Testes:**
      - Unit (`storage.service.spec.ts`): `NoSuchUpload` no complete → `MultipartUploadMissingException`. O caso "404 de escrita repassado como está" passou a usar `NoSuchKey`.
      - Unit (`videos.service.spec.ts`, 3 casos): vídeo ainda em `draft` → `202` com transição e enqueue; outra chamada já em `processing` → `202` com re-enqueue e uma só tentativa de update; sem objeto → `410` com `failed`/`UPLOAD_EXPIRED` e sem enqueue.
      - Integration com MinIO real (`storage.service.integration-spec.ts`): o segundo `CompleteMultipartUpload` do mesmo upload responde `NoSuchUpload` de verdade e vira `MultipartUploadMissingException`; o objeto montado continua lá.
      - Integration com Postgres, MinIO e Redis reais (`videos.service.integration-spec.ts`, describe `completeUpload racing a concurrent completion`): o `listParts` é espionado, lista as partes reais e completa o upload via storage antes de devolvê-las, de modo que o `complete` do fluxo recebe o `NoSuchUpload` do MinIO. Os 3 cenários: vídeo em `draft` → `202`, `processing` e job criado; a outra chamada também moveu para `processing` → `202` e job criado; o objeto foi apagado depois de montado → `410` e `failed`/`UPLOAD_EXPIRED`, sem job.

**Documentação:**
- `nestjs-project/CLAUDE.md`: a nova env aparece na lista do `.env.example`. As seções Upload flow, Status lifecycle (expiração com abort falho, `410` em qualquer vídeo expirado e retenção dos originais pela TD-12), Queue and worker (substituição de job finalizado e timeout) e Storage (mapeamento dos nomes de erro do SDK) foram atualizadas.
- O Error Catalog do plano (`phase-03-videos.md`) não foi editado. Os códigos novos por rota (`CHANNEL_NOT_FOUND` em `POST /videos` e `503 STORAGE_UNAVAILABLE` nas rotas com lazy expiry) estão neste bloco e no `openapi.json`.
- Item 11: o `nestjs-project/CLAUDE.md` descreve os `complete` concorrentes em Upload flow e o mapeamento `NoSuchUpload` → `MultipartUploadMissingException` em Storage.

**Gate (2026-11-05, dentro do container, com o `video-worker` em execução):**

| Check | Comando | Resultado |
|-------|---------|-----------|
| Unit + integration | `npm test` | 47/47 suítes, 411/411 testes, exit 0 |
| E2E | `npm run test:e2e` | 10/10 suítes, 96/96 testes, exit 0; sem "Jest did not exit" |
| Type-check | `npx tsc --noEmit` | exit 0 |
| Lint | `npm run lint` | exit 0. O `--fix` só reformatou (Prettier) 6 arquivos alterados neste review, e as mudanças foram conferidas. Os 14 erros `no-unsafe-*` dos `.bind()` sem tipo no integration spec foram corrigidos com cast para o tipo do método |
| Build da API | `npm run build` | exit 0, `dist/main.js` |
| Build do worker | `npm run build:worker` | exit 0, `dist-worker/worker/main.js` |
| Worker | `docker compose restart video-worker` | `Up`; log `Video worker started: queue "video-processing", prefix "streamtube", concurrency 1` depois do restart |
| OpenAPI | `npm run openapi:export` | `POST /videos` com `404`; `GET /videos/{publicId}`, `/stream` e `/download` com `503` |

### Security review fixes

Correções de uma revisão de segurança do código publicado, rodada em 2026-11-05. Cada uma tem uma Revision em `technical-decisions-phase-03-videos.md`.

12. **A URL de cada parte não limitava o tamanho do corpo** (Revision de 2026-11-05 no TD-03).
    - **Risco:** quem tem as URLs das partes podia gravar em cada uma até o limite por parte do storage, muito além do `file_size` declarado. O excesso só sumia na expiração de 24 h dos uploads abandonados (TD-12), e a pré-checagem do `complete` rodava tarde demais para evitar o consumo de disco.
    - **O que mudou:**
      - `StorageService.presignUploadPart` recebe o tamanho da parte e assina a URL com `ContentLength` e `signableHeaders: new Set(['content-length'])`, como na doc do `@aws-sdk/s3-request-presigner` 3.1162 consultada pelo context7. O `X-Amz-SignedHeaders` passa a ser `content-length;host`, e o MinIO responde `403` a um corpo com qualquer outro tamanho.
      - O novo `src/videos/upload-parts.util.ts` (`partCount`, `partLength`) calcula o tamanho exato de cada parte: `part_size` em todas, exceto a última, que leva o resto. O `VideosService` usa o util na sessão de upload e na pré-checagem do `complete`.
      - O contrato da API não mudou. O cliente já fatiava o arquivo em `part_size`, e a pré-checagem `UPLOAD_SIZE_MISMATCH` fica como defesa em profundidade.
    - **Testes:**
      - Unit: `upload-parts.util.spec.ts`, com 11 casos, entre eles o limite de 10 GiB = 160 partes, a última parte com resto e parte fora de `1..part_count`. Em `videos.service.spec.ts`, o tamanho assinado na parte 160 do arquivo de 10 GiB e nas partes 1 e 2 de 64 MiB + 1 byte.
      - Integration com MinIO real (`storage.service.integration-spec.ts`): um corpo 1 byte maior ou menor que o assinado recebe `403`, e nenhuma parte fica listada.
      - E2E: os cenários que enviavam partes menores que as assinadas agora usam o tamanho exato (`videos-create` 1.1, `videos-upload-resume` 1.1 e `videos-upload-complete` 1.2, com specs atualizadas). O `videos-upload-complete` 1.3 virou `tamanho-divergente-recusado-pelo-storage-409-upload-incomplete`: o PUT com o tamanho errado recebe `403`, e o `complete` responde `409 UPLOAD_INCOMPLETE`.
    - **Follow-up:** um limite de rascunhos simultâneos por usuário fica para a fase de gerenciamento de vídeos.
13. **ffprobe e ffmpeg abriam o original sem restringir o formato nem os protocolos** (Revision de 2026-11-05 no TD-06).
    - **Risco:** o allowlist de containers do `probe-parser` só rodava sobre a saída do ffprobe, depois que um demuxer já tinha interpretado o arquivo. Uma playlist HLS salva como `.mp4` levaria o worker a abrir as URLs e os arquivos locais listados nela (SSRF e leitura de arquivo local).
    - **O que mudou:** a nova constante `MEDIA_INPUT_GUARD_ARGS`, em `src/worker/media/media.constants.ts`, com `-protocol_whitelist http,https,tcp,tls -format_whitelist mov,mp4,matroska,webm`, vai antes da URL em todo `ffprobe` (`MediaProbeService`) e `ffmpeg` (`ThumbnailService`). O `Format not on whitelist` do ffprobe passou a ser `UnsupportedMediaError`, ou seja, `UNSUPPORTED_MEDIA` sem retry, como o `Invalid data found`. O allowlist pós-probe continua como defesa em profundidade.
    - **Conferido no container:**
      - MP4 faststart, M4A e WebM continuam aceitos.
      - Bytes aleatórios seguem como `Invalid data`.
      - Uma playlist HLS com `file:///etc/passwd` é barrada com `[hls] Format not on whitelist` antes de qualquer abertura.
    - **Testes:** integration com MinIO e FFmpeg reais (`media-probe.service.integration-spec.ts`). Uma playlist HLS gravada como original, apontando para `file:///etc/passwd` e `http://redis:6379`, é rejeitada com `UnsupportedMediaError`.

**Gate (2026-11-05, dentro do container, com o `video-worker` em execução):**

| Check | Comando | Resultado |
|-------|---------|-----------|
| Unit + integration | `npm test` | 48/48 suítes, 432/432 testes, exit 0 |
| E2E | `npm run test:e2e` | 10/10 suítes, 96/96 testes, exit 0 |
| Type-check | `npx tsc --noEmit` | exit 0 |
| Lint | `npm run lint` | exit 0 |

