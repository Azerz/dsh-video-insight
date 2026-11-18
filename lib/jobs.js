/**
 * 后台解析队列。
 *
 * 一次「解析」不只是总结：转写（没字幕时）→ 总结 → 思维导图 → 分镜 → 画面描述
 * 全部按顺序跑完，进度存在内存里，面板轮询 GET /jobs 拿进度条。
 * 并发数默认 2（可在 profile 配置里调），同一视频不会重复排队。
 */

const DEFAULT_CONCURRENCY = 2;
const MAX_RECORDS = 80;
const ACTIVE = new Set(['queued', 'running']);

function clean(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function snapshot(job) {
  return {
    id: job.id,
    docId: job.docId || '',
    url: job.url || '',
    title: clean(job.title, 160),
    status: job.status,
    stage: job.stage,
    stageLabel: job.stageLabel,
    percent: job.percent,
    describe: Boolean(job.describe),
    error: job.error,
    warnings: job.warnings.slice(0, 8),
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

/**
 * @param {object} options
 * @param {number} [options.concurrency] 同时跑几个任务
 * @param {(job: object, helpers: object) => Promise<void>} options.execute 真正干活
 */
export function createJobQueue({ concurrency = DEFAULT_CONCURRENCY, execute } = {}) {
  const limit = Math.max(1, Math.min(6, Math.round(Number(concurrency) || DEFAULT_CONCURRENCY)));
  const jobs = new Map();
  const queue = [];
  let running = 0;
  let seq = 0;

  function trim() {
    if (jobs.size <= MAX_RECORDS) return;
    const finished = [...jobs.values()]
      .filter((job) => !ACTIVE.has(job.status))
      .sort((a, b) => a.queuedAt - b.queuedAt);
    while (jobs.size > MAX_RECORDS && finished.length) {
      jobs.delete(finished.shift().id);
    }
  }

  function finish(job, status, error) {
    job.status = status;
    job.finishedAt = Date.now();
    if (error) job.error = clean(error?.message ?? error, 300);
    if (status === 'done') job.percent = 100;
    job.stageLabel = status === 'done' ? '已完成' : status === 'failed' ? '解析失败' : job.stageLabel;
    trim();
  }

  function pump() {
    while (running < limit && queue.length) {
      const job = queue.shift();
      if (!job || job.status !== 'queued') continue;
      job.status = 'running';
      job.startedAt = Date.now();
      job.stage = 'resolve';
      job.stageLabel = '正在解析视频信息…';
      job.percent = 1;
      running += 1;

      const controller = new AbortController();
      job.controller = controller;
      const helpers = {
        signal: controller.signal,
        isCancelled: () => job.status === 'cancelled' || controller.signal.aborted,
        setStage(stage, label, percent) {
          if (job.status === 'cancelled') return;
          if (stage) job.stage = stage;
          if (label) job.stageLabel = clean(label, 120);
          if (typeof percent === 'number' && Number.isFinite(percent)) {
            job.percent = Math.max(1, Math.min(99, Math.round(percent)));
          }
        },
        setPercent(percent) {
          if (job.status === 'cancelled') return;
          if (typeof percent === 'number' && Number.isFinite(percent)) {
            job.percent = Math.max(1, Math.min(99, Math.round(percent)));
          }
        },
        warn(message) {
          const text = clean(message, 160);
          if (text && !job.warnings.includes(text)) job.warnings.push(text);
        },
      };

      Promise.resolve()
        .then(() => execute(job, helpers))
        .then(() => {
          if (job.status === 'running') finish(job, 'done');
        })
        .catch((error) => {
          if (job.status === 'cancelled' || error?.name === 'AbortError' || error?.code === 'aborted') {
            finish(job, 'cancelled');
            return;
          }
          finish(job, 'failed', error);
        })
        .finally(() => {
          running -= 1;
          pump();
        });
    }
  }

  return {
    concurrency: limit,
    /** 启动一个任务；同一视频已有排队/运行中的任务时直接返回那一个。 */
    start({ docId = '', url = '', title = '', describe = true } = {}) {
      const id = String(docId ?? '').trim();
      const link = String(url ?? '').trim();
      if (!id && !link) throw new Error('需要 docId 或 url');
      for (const job of jobs.values()) {
        if (!ACTIVE.has(job.status)) continue;
        if ((id && job.docId === id) || (!id && link && job.url === link)) return { job: snapshot(job), created: false };
      }
      seq += 1;
      const job = {
        id: `job-${Date.now().toString(36)}-${seq}`,
        docId: id,
        url: link,
        title: clean(title, 160),
        status: 'queued',
        stage: 'queued',
        stageLabel: '排队中…',
        percent: 0,
        describe: describe !== false,
        error: '',
        warnings: [],
        queuedAt: Date.now(),
        startedAt: 0,
        finishedAt: 0,
        controller: null,
      };
      jobs.set(job.id, job);
      queue.push(job);
      trim();
      pump();
      return { job: snapshot(job), created: true };
    },
    /** 取消排队中或运行中的任务。 */
    cancel({ id = '', docId = '' } = {}) {
      const key = String(id ?? '').trim();
      const target = String(docId ?? '').trim();
      let cancelled = 0;
      for (const job of jobs.values()) {
        if (!ACTIVE.has(job.status)) continue;
        if (key ? job.id !== key : job.docId !== target) continue;
        job.status = 'cancelled';
        job.stageLabel = '已取消';
        job.finishedAt = Date.now();
        try {
          job.controller?.abort();
        } catch {
          /* ignore */
        }
        cancelled += 1;
      }
      pump();
      return cancelled;
    },
    /** 清掉已结束的记录。 */
    clearFinished() {
      for (const [id, job] of jobs) {
        if (!ACTIVE.has(job.status)) jobs.delete(id);
      }
      return this.list().jobs.length;
    },
    list() {
      const all = [...jobs.values()]
        .sort((a, b) => b.queuedAt - a.queuedAt)
        .slice(0, MAX_RECORDS)
        .map(snapshot);
      return {
        concurrency: limit,
        active: all.filter((job) => ACTIVE.has(job.status)).length,
        running: all.filter((job) => job.status === 'running').length,
        jobs: all,
      };
    },
    isActive(docId) {
      for (const job of jobs.values()) {
        if (job.docId === docId && ACTIVE.has(job.status)) return true;
      }
      return false;
    },
  };
}
