---
libs:
  "@nestjs/bullmq":
    version: "^12.0.0"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-11-04T17:33:48-03:00"
  bullmq:
    version: "^6.4.0"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-11-04T17:33:48-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1154.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-04T17:33:48-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1154.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-04T17:33:48-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-04T23:22:10-03:00"
---

# phase-03-videos — Library References

Trechos de documentação das libraries decididas nesta fase, já adaptados ao uso do projeto. Recarregar quando o TD de origem mudar: o resolve atualiza este arquivo quando o conjunto de libs do `## Decisions Index` diverge do cache daqui.

**Como a consulta foi feita.** Os trechos vieram da API HTTP pública do Context7, o mesmo serviço e os mesmos IDs de biblioteca do MCP `context7`, que não estava carregado na sessão. O resolve-library-id usou `GET https://context7.com/api/v1/search?query=<nome>`, escolhendo o ID de maior reputação e cobertura. O query-docs usou `GET https://context7.com/api/v1<ID>?type=txt&topic=<tópico>&tokens=<n>`. Nos tópicos em que a busca por `topic` não trouxe os trechos de S3 e Redis (checksums, `forcePathStyle`, multipart de baixo nível, `noeviction`), foi usado o endpoint por consulta semântica `GET https://context7.com/api/v2/context?libraryId=<ID>&query=<consulta>&type=txt`, que serve o mesmo índice.

**Versões.** Nenhuma das quatro libs está instalada em `nestjs-project/` hoje, e as versões acima vêm dos `**Libraries:**` de TD-01 e TD-02. O Context7 indexa as libs pelo branch principal. A tag mais recente indexada é `v6.3.11` para `/taskforcesh/bullmq` e `v3.1153.0` para `/aws/aws-sdk-js-v3`, ambas um pouco abaixo das faixas decididas (`^6.4.0`, `^3.1154.0`); nenhum trecho abaixo depende de API introduzida depois dessas tags. Para `@nestjs/bullmq@^12.0.0`, confirmar no `npm install` os `peerDependencies` contra o `@nestjs/core ^11.0.1` atual do projeto.

### @nestjs/bullmq

**Source:** `/nestjs/docs.nestjs.com` (Context7), com trust 9.7, 6062 snippets e página `content/application/queues.md`. Complemento: `/nestjs/bull`, repositório do pacote (`_autodocs/api-reference`), para `getQueueToken` e `BullRootModuleOptions`. Mapeia `phase-03-videos/TD-01` Decision A e sustenta TD-04, TD-05 e TD-11.

#### Root module: `BullModule.forRootAsync` (connection + prefix)

`BullRootModuleOptions` estende o `QueueOptions` do BullMQ: o `forRoot`/`forRootAsync` aceita `connection`, `prefix`, `defaultJobOptions`, `limiter`, `settings` etc., e esses valores valem como padrão para todas as filas registradas. Padrão da doc:

```typescript
BullModule.forRootAsync({
  imports: [ConfigModule],
  useFactory: async (configService: ConfigService) => ({
    connection: {
      host: configService.get('QUEUE_HOST'),
      port: configService.get('QUEUE_PORT'),
    },
  }),
  inject: [ConfigService],
});
```

Adaptado às convenções herdadas: um `registerAs` por domínio em `src/config/` com validação Joi (`phase-01-configuracao-base/TD-01..TD-03`), injeção por `ConfigType` + `KEY`, igual ao `TypeOrmModule.forRootAsync`. Pela Revision 2026-11-04 de TD-01 ("Queue contract names"), o prefixo vem de `QUEUE_PREFIX` (`streamtube` em dev, `streamtube-test` nos testes); `REDIS_HOST`/`REDIS_PORT` seguem o padrão `*_HOST`/`*_PORT` das configs existentes (`DB_HOST`, `MAIL_HOST`).

```typescript
// src/config/queue.config.ts
export default registerAs('queue', () => ({
  host: process.env.REDIS_HOST,              // nome do serviço Compose (ex.: `redis`), nunca localhost
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  prefix: process.env.QUEUE_PREFIX ?? 'streamtube', // TD-01 Revision; TD-11: a suíte de teste usa `streamtube-test`
}));

// módulo de fila
BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.host, port: cfg.port },
    prefix: cfg.prefix,
    defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } }, // TD-04: 3 tentativas; delay ilustrativo
  }),
});
```

Variantes da doc: `useClass` (classe que implementa `SharedBullConfigurationFactory.createSharedConfiguration()`), `useExisting`, configuração nomeada `forRoot('alternative-config', {...})` + `registerQueue({ configKey, name })` e `extraOptions.manualRegistration` com `BullRegistrar.register()`. Nada disso é necessário nesta fase.

#### Fila e producer: `registerQueue`, `@InjectQueue`

```typescript
BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }); // 'video-processing' (Revision 2026-11-04 de TD-01)

@Injectable()
export class VideoProcessingProducer {
  constructor(@InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue) {}

  enqueue(videoId: string) {
    // TD-01 Revision: job `process-video`, payload { videoId } e jobId = uuid do vídeo;
    // a conclusão idempotente (TD-03/TD-04) re-enfileira com o mesmo id
    return this.queue.add(PROCESS_VIDEO_JOB, { videoId }, { jobId: videoId }); // PROCESS_VIDEO_JOB = 'process-video'
  }
}
```

- `@InjectQueue(name)` resolve o token `BullQueue_<name>`, o mesmo de `getQueueToken(name)`, abaixo.
- `registerQueueAsync({ name, useFactory })` exige o `name` **fora** da factory.
- `registerQueue({ name, connection: {...} })` sobrescreve a conexão padrão para uma fila específica. É o gancho para o `enableOfflineQueue: false` só no producer (seção `bullmq`).
- Quem publica é a API, em `POST /videos/{publicId}/upload/complete`, depois da transição condicional `draft → processing` (TD-03, TD-04, DG-1).

#### Consumer: `extends WorkerHost` + `@Processor`

Em `@nestjs/bullmq` o padrão é **estender `WorkerHost` e implementar `process(job)`**. O decorator `@Process('nome')` é do antigo `@nestjs/bull` e não é suportado no BullMQ. Jobs nomeados são roteados por `job.name` dentro de `process()`. O valor retornado fica gravado no job.

```typescript
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingConsumer extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> {
    // probing + thumbnail (TD-06). Erro transitório: deixar propagar (o BullMQ re-tenta).
    // Mídia sem stream de vídeo: throw new UnrecoverableError(...) (falha sem retry).
  }
}
```

- Consumers precisam estar registrados como providers para o `@nestjs/bullmq` descobri-los.
- **Registrar o `VideoProcessingConsumer` apenas no `WorkerModule`**, inicializado por `src/worker/main.ts` com `NestFactory.createApplicationContext(WorkerModule)` (TD-05). Se ele também estiver no grafo de módulos da API, o processo da API passa a consumir jobs e o FFmpeg roda no container errado.
- Processor em processo separado (`registerQueue({ processors: [path] })`) não tem DI. Não usar: o TD-05 já separa por container.

#### Eventos do worker: `@OnWorkerEvent('failed')`

`@OnWorkerEvent(eventName)` registra um listener de `WorkerListener` (`'active'`, `'completed'`, `'failed'`, `'error'`, `'progress'`, `'stalled'`, `'closing'`, `'closed'`, `'drained'`…). A classe precisa ter `@Processor`, e o listener fica ligado ao worker criado para ela. A assinatura do `failed` no BullMQ é `(job: Job | undefined, error: Error, prev: string)`.

```typescript
@OnWorkerEvent('failed')
async onFailed(job: Job<{ videoId: string }> | undefined, error: Error) {
  if (!job) return;
  const exhausted = error instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
  if (!exhausted) return; // ainda haverá retry
  // grava `failed` + `processing_error` (TD-04). Único ponto em que vale catch-and-log sem rethrow.
}
```

O TD-04 lembra que o evento `failed` também dispara para jobs travados (stalled), então o estado final `failed` é gravado sempre aqui.

#### `getQueueToken`: acesso por `ModuleRef` e testes

```typescript
// a doc do pacote importa de '@nestjs/bull-shared' (dependência do @nestjs/bullmq)
import { getQueueToken } from '@nestjs/bull-shared';
import { Queue } from 'bullmq';

const queue = moduleRef.get<Queue>(getQueueToken('audio')); // token: `BullQueue_audio` (ou `BullQueue_default` sem nome)
```

- **TD-11:** nos e2e, obter a fila real do app com `app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE))` para inspecionar jobs sob o prefixo de teste. Em teste de compilação de módulo, o mesmo token serve para `overrideProvider(...)`.
- Confirmar ao implementar se o `@nestjs/bullmq` reexporta `getQueueToken`. Se não reexportar, importar de `@nestjs/bull-shared`, que já vem como dependência.

### bullmq

**Source:** `/taskforcesh/bullmq` (Context7), com trust 9.2 e 4503 snippets. Páginas: `guide/retrying-failing-jobs.md`, `patterns/stop-retrying-jobs.md`, `guide/jobs/job-ids.md`, `patterns/throttle-jobs.md`, `guide/queues/auto-removal-of-jobs.md`, `patterns/failing-fast-when-redis-is-down.md`, `guide/going-to-production.md`, `guide/connections.md`, `guide/workers/graceful-shutdown.md`. Mapeia `phase-03-videos/TD-01` Decision A, com as regras de retry e falha do TD-04.

#### Retries limitadas: `attempts` + `backoff` (TD-04)

```typescript
await queue.add('process-video', { videoId }, {
  attempts: 3,                                   // TD-04: 3 tentativas
  backoff: { type: 'exponential', delay: 1000 }, // espera 2^(attempts-1) * delay ms
});
```

- `backoff: { type: 'fixed', delay }` mantém o intervalo constante.
- `jitter` (0..1) aleatoriza o exponencial.
- O mesmo objeto pode ir em `defaultJobOptions`, na `Queue` ou no `forRoot`, para não repetir em cada `add()`.

#### Falha definitiva: `UnrecoverableError` (TD-04 / TD-06)

Lançar `UnrecoverableError` move o job direto para `failed`, **ignorando `attempts`**. É o caminho para "arquivo sem stream de vídeo / mídia não suportada" (TD-06) e para timeout definitivo.

```typescript
import { Worker, UnrecoverableError } from 'bullmq';

const worker = new Worker('foo', async job => {
  doSomeProcessing();
  throw new UnrecoverableError('Unrecoverable');
}, { connection });
```

Um erro comum (`Error`) só vai para `failed` depois de esgotar as tentativas. Quando um job esgota as tentativas, o stream de eventos emite também `retries-exhausted`.

#### `jobId` customizado (conclusão idempotente, TD-03/TD-04)

- `queue.add(name, data, { jobId })` **ignora** o job quando já existe um com o mesmo id na fila. É a deduplicação usada pela conclusão idempotente.
- O id customizado **não pode conter `:`** nem ser **só numérico**. O uuid do vídeo atende, e é o `jobId` fixado pela Revision 2026-11-04 de TD-01.
- **Atenção à interação com auto-remoção:** com `removeOnComplete`/`removeOnFail`, um job já removido deixa de contar como existente, e um novo `add` com o mesmo id é aceito. A garantia contra reprocessar um vídeo `ready` é a transição condicional de status no banco (TD-04), não o `jobId`.

#### `removeOnComplete` / `removeOnFail`

```typescript
await queue.add('process-video', data, { removeOnComplete: true, removeOnFail: 1000 }); // remove concluídos; mantém os últimos 1000 falhos
// ou por idade/quantidade (KeepJobs): { removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 24 * 3600 } }
```

- A doc recomenda manter poucos concluídos e muitos falhos.
- A remoção é preguiçosa: só ocorre quando outro job termina ou falha.
- O valor pode ir em `defaultJobOptions` da fila ou nas opções do `Worker`.
- Como o estado do vídeo vive no PostgreSQL (TD-04), não é preciso reter jobs concluídos no Redis.

#### Producer fail-fast: `enableOfflineQueue: false`

Com `enableOfflineQueue: false` na conexão da `Queue`, `add()` falha na hora quando o Redis está fora, em vez de esperar a reconexão. A doc também avisa que **o Redis precisa estar no ar quando a fila é instanciada**.

```typescript
const myQueue = new Queue('transcoding', { connection: { enableOfflineQueue: false } });
// app.post(...) → try { await myQueue.add(...) } catch { res.status(503) }
```

Adaptação:
- Aplicar **só no lado producer (API)**. No Nest, isso vai na `connection` do `forRootAsync`/`registerQueue` carregado pela API; o `WorkerModule` mantém a conexão padrão.
- O erro de `add()` em `upload/complete` vira `503 QUEUE_UNAVAILABLE` no envelope `{ statusCode, error, message }` (`phase-02-auth/TD-07`). O status do vídeo volta para `draft` (Revision 2026-11-04 de TD-03, "Upload error contract"), e o cliente pode repetir a chamada.
- Nesse ponto o multipart já foi montado e o `UploadId` deixou de existir. Pela Revision 2026-11-04 de TD-03 ("Completion retry after an enqueue failure"), a repetição não remonta nada: o `ListParts` acusa upload inexistente, o `HeadObject` acha o objeto com o tamanho declarado, o vídeo vai para `processing` e o `add()` é refeito com o mesmo `jobId` (`202`). O fluxo completo está na seção multipart de `@aws-sdk/client-s3`.
- No Compose, `nestjs-api` e `video-worker` devem depender de `redis` com `condition: service_healthy`.

#### Redis: `maxmemory-policy noeviction` (+ AOF, `maxRetriesPerRequest`)

- **`maxmemory-policy` precisa ser `noeviction`.** É a única configuração que garante o funcionamento correto das filas, porque o BullMQ quebra se o Redis expulsar chaves.
- A doc de produção recomenda AOF (`appendonly yes`, fsync por segundo).
- Workers usam `maxRetriesPerRequest: null`. O `Worker` já define esse valor por padrão; não sobrescrever nem passar uma instância ioredis própria sem ele, senão o BullMQ emite aviso ou lança exceção.

```yaml
# nestjs-project/compose.yaml (serviço redis)
command: ["redis-server", "--maxmemory-policy", "noeviction", "--appendonly", "yes"]
```

#### Encerramento: `close()`

```typescript
await worker.close(); // marca o worker como closing, para de pegar jobs e espera os ativos terminarem (sem timeout)
await queue.close();
```

A doc pede fechar o worker em `SIGINT`/`SIGTERM` para minimizar jobs travados, e avisa que um job mais longo que o grace period ainda pode travar. Adaptação ao TD-05:
- No `src/worker/main.ts`, habilitar `app.enableShutdownHooks()` para que o `SIGTERM` do Compose encerre o contexto Nest.
- O `stop_grace_period` do `video-worker` precisa cobrir a duração esperada de um job.
- Confirmar no código do `@nestjs/bullmq` que o shutdown do módulo chama `close()` em workers e filas; se não chamar, fechar explicitamente num hook `onApplicationShutdown`.
- Conexões compartilhadas criadas à mão não são fechadas pelo `close()` da fila e precisam ser fechadas depois.

### @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3` (Context7), com trust 9.6 e 11189 snippets. Arquivos: `clients/client-s3/src/commands/*`, `clients/client-s3/src/models/models_0.ts`, `clients/client-s3/src/S3.ts`, `clients/client-s3/test/unit/S3.spec.ts`, `supplemental-docs/CLIENTS.md`, `supplemental-docs/MD5_FALLBACK.md`, `supplemental-docs/EFFECTIVE_PRACTICES.md` e `packages-internal/checksums/.../flexible-checksums/*`. Mapeia `phase-03-videos/TD-02` Decision A, com TD-03 e TD-06.

#### Cliente S3-compatível: `forcePathStyle` + checksums `WHEN_REQUIRED`

`forcePathStyle: true` coloca o bucket no path (`host/bucket/key`) em vez do subdomínio. É o que o MinIO atrás de um nome de serviço Compose exige. O teste unitário do SDK mostra `endpoint: 'http://localhost:8080/path'` + `forcePathStyle: true` gerando `path === '/path/bucket/key'`.

**Mudança de padrão da v3.729.0 (issue aws-sdk-js-v3#6810):**
- O SDK passou a usar checksums modernos (CRC32) por padrão para integridade de objeto no S3, onde antes usava MD5.
- O padrão é `requestChecksumCalculation = WHEN_SUPPORTED`. Com ele, toda operação com `requestAlgorithmMember` modelado (`PutObject`, `UploadPart`) recebe `x-amz-sdk-checksum-algorithm` + `x-amz-checksum-crc32`, mesmo com `requestChecksumRequired: false`.
- A doc registra que alguns serviços S3-compatíveis de terceiros não suportam esses checksums.
- Numa URL pré-assinada de `UploadPart`, o checksum calculado pelo SDK entra no request assinado, e o cliente que faz o `PUT` da parte não consegue reproduzi-lo. Com isso a URL pré-assinada quebra.
- Com `WHEN_REQUIRED`, o checksum só é adicionado quando a operação exige ou quando `ChecksumAlgorithm` é passado explicitamente. Segundo a doc, "for `UploadPartCommand`, `requestChecksumRequired` is false, so setting `WHEN_REQUIRED` prevents the default CRC32 from being added".
- Os dois parâmetros são construtores específicos do S3 e aceitam `WHEN_REQUIRED` | `WHEN_SUPPORTED`.

```typescript
// src/config/storage.config.ts (registerAs) → StorageModule
const internalClient = new S3Client({
  endpoint: cfg.endpoint,                 // S3_ENDPOINT, ex.: http://minio:9000 (nome do serviço Compose)
  region: cfg.region,
  forcePathStyle: true,
  credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
// o client de assinatura (S3_PUBLIC_ENDPOINT) usa as mesmas opções: ver a seção do presigner
```

#### Multipart de baixo nível (TD-03)

Este projeto **não** usa `@aws-sdk/lib-storage` (`Upload`). Esse helper envia os bytes pelo processo Node, e o TD-03 exige que eles nunca passem pela API. O fluxo usa os comandos diretamente, com chave `videos/{videoId}/original` (TD-02):

```typescript
import {
  CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand, HeadObjectCommand, DeleteObjectCommand, paginateListParts,
} from '@aws-sdk/client-s3';

// 1. POST /videos — cria o rascunho e o multipart; persistir o UploadId
const { UploadId } = await internalClient.send(new CreateMultipartUploadCommand({
  Bucket, Key: `videos/${videoId}/original`, ContentType: declaredMimeType, // allowlist do TD-03
}));

// 2. URLs das partes: getSignedUrl(signingClient, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }))
//    ver @aws-sdk/s3-request-presigner — o cliente faz PUT de cada parte direto no storage

// 3. POST /videos/{publicId}/upload/complete — o servidor lista as partes (não confia em ETag vindo do cliente)
//    Se o ListParts falhar com upload inexistente (404 `NoSuchUpload`) e o vídeo estiver `draft`, ir para o ramo 5.
const parts: { PartNumber: number; ETag: string; Size: number }[] = [];
for await (const page of paginateListParts({ client: internalClient }, { Bucket, Key, UploadId })) {
  for (const p of page.Parts ?? []) parts.push({ PartNumber: p.PartNumber!, ETag: p.ETag!, Size: p.Size! });
}
// pré-checagem ANTES de concluir (Revisions 2026-11-04 do TD-03):
//   partes não contíguas (1..N) ou ausentes → 409 UPLOAD_INCOMPLETE; o vídeo continua `draft`
//   soma de Size !== file_size declarado     → 409 UPLOAD_SIZE_MISMATCH; o vídeo continua `draft`
//   (o cliente reenvia as partes problemáticas dentro da janela de upload)
await internalClient.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: parts.map(({ PartNumber, ETag }) => ({ PartNumber, ETag })) },
}));

// 4. reconferência no objeto montado (TD-03): ContentLength precisa ser igual ao file_size declarado
const { ContentLength } = await internalClient.send(new HeadObjectCommand({ Bucket, Key }));
if (ContentLength !== declaredSize) {
  // Revision 2026-11-04 "Size mismatch outcome": apaga o objeto montado, grava o vídeo como
  // `failed` com processing_error `PROCESSING_FAILED`, não enfileira nada e responde
  // 409 UPLOAD_SIZE_MISMATCH. O mesmo upload não se recupera; o cliente inicia um novo.
  await internalClient.send(new DeleteObjectCommand({ Bucket, Key }));
}
// objeto conferido → transição `draft → processing` + add() do job; se o add() falhar → `draft` + 503 QUEUE_UNAVAILABLE

// 5. repetição da conclusão depois de 503 QUEUE_UNAVAILABLE (Revision 2026-11-04 "Completion retry after an
//    enqueue failure" do TD-03): o vídeo está `draft`, mas o multipart já foi montado e o UploadId não existe mais
try {
  const head = await internalClient.send(new HeadObjectCommand({ Bucket, Key }));
  // head.ContentLength === declaredSize → pula o CompleteMultipartUpload, `draft → processing`, add() com o mesmo jobId, 202
} catch (e) {
  // e.name === 'NotFound' (HEAD 404 sem corpo) → 410 UPLOAD_EXPIRED; o vídeo vira `failed` (UPLOAD_EXPIRED)
}

// cancelamento / expiração do rascunho
await internalClient.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
```

- `CompleteMultipartUploadCommand` recebe `MultipartUpload.Parts: CompletedPart[]` (`ETag`, `PartNumber` e, opcionalmente, checksums), além de `Bucket`, `Key` e `UploadId`.
- `paginateListParts(config, input)` é um async iterator. O `config.client` precisa ser um `S3Client`, e `PartNumberMarker` é gerido pelo paginator. Paginar sempre, mesmo esperando 160 partes no limite de 10 GiB.
- O endpoint de retomada do TD-03 reusa o mesmo `paginateListParts` para descobrir as partes já enviadas e reassina só as que faltam. Se o storage disser que o upload não existe mais, o `HeadObject` desempata: com o objeto já montado (o `draft` deixado por um `503 QUEUE_UNAVAILABLE`), a rota responde `409 INVALID_VIDEO_STATE`, porque não há partes a reenviar (Revision 2026-11-04 "Completion retry after an enqueue failure"); sem objeto, responde `410 UPLOAD_EXPIRED` e o vídeo vira `failed`.
- Erros de serviço: tratar pelo `name` do erro ou por `$metadata.httpStatusCode` (`supplemental-docs/ERROR_HANDLING.md`). O `HeadObject` de uma chave inexistente lança `NotFound`, porque o 404 do HEAD vem sem corpo (`loadRestXmlErrorCode`, o mesmo critério do waiter `waitForObjectNotExists`). Para o `ListParts` de um upload concluído ou abortado, o S3 responde 404 com o código `NoSuchUpload`. O Context7 não indexa esse código, então confirmar no `implement` contra o MinIO real e decidir pelo `httpStatusCode === 404`.
- Os próprios helpers do SDK falham quando a resposta de `UploadPart` vem sem `ETag` ("Missing Bucket CORS configuration for ETag header?"). Aqui o `ETag` é lido pelo servidor via `ListParts`, então a CORS do bucket para o navegador futuro não precisa expor `ETag`. Pela Revision 2026-11-04 do TD-03, ela libera a origem do frontend com os métodos `PUT` (partes) e `GET` (mídia) e será configurada na fase que trouxer o `next-frontend`.

#### `HeadObject`, `PutObject`, `GetObject`

- **`HeadObjectCommand`:** só metadados, sem `Body`. Serve para a reconferência de `ContentLength` na conclusão (TD-03): se o valor difere do `file_size` declarado, o objeto montado é apagado e o vídeo vira `failed` (`PROCESSING_FAILED`), com resposta `409 UPLOAD_SIZE_MISMATCH`. Também desempata a repetição da conclusão e a retomada quando o multipart já não existe (Revision "Completion retry after an enqueue failure"): objeto com o tamanho declarado → segue para o enfileiramento (`202`) ou `409 INVALID_VIDEO_STATE` na retomada; `NotFound` → `410 UPLOAD_EXPIRED`.
- **`DeleteObjectCommand`:** `{ Bucket, Key }`. Apaga o objeto montado `videos/{videoId}/original` quando a reconferência do `HeadObject` falha (Revision 2026-11-04 "Size mismatch outcome" do TD-03). Em S3/MinIO, apagar uma chave inexistente também responde sucesso, então a chamada é idempotente.
- **`PutObjectCommand`:** o worker grava `videos/{videoId}/thumbnail.jpg` com `ContentType: 'image/jpeg'` (TD-06). `Body` aceita `Buffer` ou stream. Como a thumbnail é pequena, gravar em `Buffer`, que também dá um `ContentLength` conhecido.
- **`GetObjectCommand`:** o `Body` é stream e precisa ser consumido ou descartado para liberar o socket.

```typescript
const res = await internalClient.send(new GetObjectCommand({ Bucket, Key }));
const bytes = await res.Body!.transformToByteArray(); // ou transformToString(); ou (res.Body as Readable).destroy()
```

Nesta fase, o `GetObject` direto aparece sobretudo nos testes de integração contra o MinIO real (TD-11). A leitura do original pelo ffprobe usa URL pré-assinada interna (TD-06), não `GetObject`.

### @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` (Context7), arquivos `packages/s3-request-presigner/README.md` e `clients/client-s3/src/commands/GetObjectCommand.ts`, mais os snapshots de request SigV4 do SDK. Mapeia `phase-03-videos/TD-02` Decision A, com TD-03, TD-06 e TD-08.

#### `getSignedUrl`: URLs das partes do upload (TD-03)

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UploadPartCommand } from '@aws-sdk/client-s3';

const url = await getSignedUrl(
  signingClient,
  new UploadPartCommand({ Bucket, Key: `videos/${videoId}/original`, UploadId, PartNumber }),
  { expiresIn: 3600 }, // TD-03: TTL de 1 h por URL de parte
);
```

- Sem `expiresIn`, o padrão é 900 s.
- `getSignedUrl` recebe um `S3Client` e um command. As opções `signableHeaders` (ex.: `content-type`) e `unhoistableHeaders` (`x-amz-*`) forçam headers a entrar na assinatura e a serem obrigatórios no request do cliente.
- Com `requestChecksumCalculation: 'WHEN_REQUIRED'` no client, nenhum `x-amz-checksum-*` é embutido na URL de `UploadPart`, e o cliente faz só o `PUT` dos bytes da parte.

#### URLs de streaming e download (TD-08), com `ResponseContentDisposition`

`GET /videos/{publicId}/stream` e `/download` respondem `200 { url, expires_at }` só com o vídeo em `ready`. O storage serve os bytes e responde `Range` com `206`.

Ordem das checagens antes de assinar (Revision 2026-11-04 de TD-08): primeiro a de dono do TD-09 (não-dono → `404 VIDEO_NOT_FOUND` em qualquer estado); depois a de estado (`draft`, `processing` ou `failed` → `409 VIDEO_NOT_READY`, no envelope de `phase-02-auth/TD-07`). Só então `getSignedUrl` é chamado.

```typescript
import { GetObjectCommand } from '@aws-sdk/client-s3';

const Key = `videos/${videoId}/original`;
// TD-08 (Revisions 2026-11-04): TTLs diferentes por endpoint; só chega aqui vídeo `ready` do dono
const streamExpiresIn = durationSeconds == null
  ? 3600 // `ready` sem duração informada pelo probing: piso de 1 h
  : Math.min(Math.max(2 * durationSeconds, 3600), 43200); // clamp(2 × duration_seconds, 1 h, 12 h)
const downloadExpiresIn = 3600; // 1 h
const streamUrl = await getSignedUrl(signingClient, new GetObjectCommand({ Bucket, Key }), { expiresIn: streamExpiresIn });
const downloadUrl = await getSignedUrl(signingClient, new GetObjectCommand({
  Bucket, Key,
  // RFC 5987 (TD-08): fallback ASCII + filename* em UTF-8
  ResponseContentDisposition: `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
}), { expiresIn: downloadExpiresIn });
// expires_at = agora + expiresIn (de cada URL), devolvido nas duas respostas
```

- O stream usa `2 × duration_seconds` com piso de 1 h e teto de 12 h porque cada requisição `Range` do player é um request assinado novo e a URL precisa valer até o fim da reprodução. Se o probing não informou `duration_seconds`, o stream usa o piso de 1 h. O download usa 1 h: a assinatura é verificada quando a transferência começa, e um download longo continua depois de a URL expirar.
- `expiresIn` é em segundos; o teto do SigV4 é 7 dias (604800 s), bem acima dos 43200 s do stream.

- `fileName` é o `original_filename` declarado na iniciação do upload (TD-03), persistido no vídeo (Revision 2026-11-04 de TD-08, "Download filename"); `asciiFallback` é esse nome com os caracteres fora de ASCII imprimível trocados por `_` e sem aspas. A URL de stream não leva disposition e toca inline.
- Thumbnail (Revision 2026-11-04 de TD-06): com o vídeo `ready`, `GET /videos/{publicId}` devolve `thumbnail_url`, um `GetObjectCommand` de `videos/{videoId}/thumbnail.jpg` assinado pelo client público com `expiresIn: 3600`; nos outros estados, ou sem thumbnail, `thumbnail_url` é `null`.
- `ResponseContentDisposition` vira o parâmetro de query `response-content-disposition` e sobrescreve o header `Content-Disposition` da resposta.
- Pela JSDoc do `GetObject`, esses parâmetros de override **só funcionam em request assinado** (header `Authorization` ou URL pré-assinada), nunca em request anônimo. Isso casa com o bucket privado do TD-02.

#### Host assinado: um client por endpoint

O SigV4 sempre inclui `host` em `SignedHeaders`; os snapshots de request do SDK mostram `SignedHeaders=…;host;…`. A URL pré-assinada só vale para o host com que o client foi configurado, e o host não pode ser reescrito depois de assinar. Por isso o TD-02 define dois clients:

| Client | Endpoint | Uso |
|--------|----------|-----|
| interno | `S3_ENDPOINT` (ex.: `http://minio:9000`, nome do serviço Compose) | operações de servidor (multipart, `ListParts`, `HeadObject`, `PutObject`) e a URL pré-assinada interna que o worker passa ao `ffprobe`/`ffmpeg` (TD-06) |
| de assinatura | `S3_PUBLIC_ENDPOINT` (endereço do MinIO como o cliente o enxerga) | só `getSignedUrl` das URLs entregues ao cliente: partes (TD-03), stream e download (TD-08) |

Os dois usam `forcePathStyle: true` e os checksums em `WHEN_REQUIRED`. Pela Revision 2026-11-04 do TD-02, no Compose de dev e nos testes (TD-11) `S3_PUBLIC_ENDPOINT` = `http://minio:9000`, igual ao interno e alcançável de dentro dos containers. Para um cliente rodando no host, o valor é sobrescrito para `http://localhost:9000`. O `S3RequestPresigner` também aceita `{ ...s3.config }` de um client existente, mas o caminho padrão aqui é `getSignedUrl(client, command, opts)`.
