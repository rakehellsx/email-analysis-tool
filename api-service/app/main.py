"""FastAPI 邮件安全分析服务入口。"""

from __future__ import annotations

import logging
import traceback
import uuid
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .analyzer import EmailAnalyzer
from .config import settings
from .model_training import train_jsonl_model
from .task_store import TaskStore
from .training_store import TrainingTaskStore

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("mail_analyzer")

settings.ensure_directories()
store = TaskStore(settings.database_path)
training_store = TrainingTaskStore(settings.database_path)
analyzer = EmailAnalyzer(settings)

app = FastAPI(
    title="邮件安全分析服务",
    version="1.0.0",
    description="上传 EML 后异步解析邮件、执行 YAML 规则、机器学习文本分类以及可选 Rspamd 检测。",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

static_dir = settings.project_root / "static"
if static_dir.is_dir():
    app.mount("/static", StaticFiles(directory=static_dir), name="static")


@app.get("/", include_in_schema=False)
def console() -> FileResponse:
    """部署在同一服务中的最小操作控制台。"""
    return FileResponse(static_dir / "index.html")


def _process_task(task_id: str) -> None:
    """后台线程执行；任何异常均转换为可查询的失败状态。"""
    try:
        store.mark_running(task_id)
        eml_path = store.get_eml_path(task_id)
        if eml_path is None or not eml_path.exists():
            raise FileNotFoundError("任务原始 EML 文件不存在")
        result = analyzer.analyze(eml_path.read_bytes())
        store.complete(task_id, result)
        logger.info("task=%s completed nature=%s", task_id, result["analysis"]["verdict"]["nature"])
    except Exception as exc:  # pragma: no cover - 由 API 集成测试覆盖任务状态
        logger.error("task=%s failed: %s\n%s", task_id, exc, traceback.format_exc())
        store.fail(task_id, f"{type(exc).__name__}: {exc}")


def _process_training_task(task_id: str) -> None:
    """后台训练受限模型，并在替换工件后刷新在线分析器的模型引用。"""
    global analyzer
    try:
        training_store.mark_running(task_id)
        dataset_path = training_store.get_dataset_path(task_id)
        if dataset_path is None or not dataset_path.exists():
            raise FileNotFoundError("训练数据文件不存在")
        result = train_jsonl_model(dataset_path, settings.model_path, settings.min_training_samples)
        analyzer = EmailAnalyzer(settings)
        training_store.complete(task_id, result)
        logger.info("training_task=%s completed samples=%s", task_id, result["samples"])
    except Exception as exc:  # pragma: no cover - 由 API 集成测试覆盖状态结果
        logger.error("training_task=%s failed: %s\n%s", task_id, exc, traceback.format_exc())
        training_store.fail(task_id, f"{type(exc).__name__}: {exc}")


@app.get("/healthz", tags=["系统"])
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/v1/emails", status_code=status.HTTP_202_ACCEPTED, tags=["邮件分析"])
async def submit_email(background_tasks: BackgroundTasks, file: UploadFile = File(...)) -> JSONResponse:
    """上传一个 EML 文件并返回可用于查询的异步任务标识。"""
    filename = Path(file.filename or "uploaded.eml").name
    if not filename.lower().endswith(".eml"):
        raise HTTPException(status_code=415, detail="仅接受 .eml 格式的 RFC 822 邮件文件")
    raw_eml = await file.read(settings.max_upload_bytes + 1)
    if not raw_eml:
        raise HTTPException(status_code=400, detail="上传的 EML 文件为空")
    if len(raw_eml) > settings.max_upload_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"文件超过大小限制：最大 {settings.max_upload_bytes} 字节",
        )

    task_id = str(uuid.uuid4())
    job_path = settings.job_dir / task_id
    job_path.mkdir(mode=0o700, parents=True, exist_ok=False)
    eml_path = job_path / "message.eml"
    eml_path.write_bytes(raw_eml)
    try:
        eml_path.chmod(0o600)
    except OSError:
        logger.warning("无法调整任务文件权限: %s", eml_path)
    store.create(task_id, filename, eml_path, len(raw_eml))
    background_tasks.add_task(_process_task, task_id)

    payload = {
        "task_id": task_id,
        "status": "queued",
        "message": "邮件已接收，正在后台分析。请使用 task_id 查询结果。",
        "status_url": f"/api/v1/tasks/{task_id}",
    }
    return JSONResponse(status_code=status.HTTP_202_ACCEPTED, content=payload)


@app.get("/api/v1/tasks/{task_id}", tags=["邮件分析"])
def get_task(task_id: str) -> dict:
    """返回任务生命周期状态；仅完成任务附带完整分析结果。"""
    task = store.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="未找到指定任务")
    return task


@app.post("/api/v1/models/train", status_code=status.HTTP_202_ACCEPTED, tags=["机器学习"])
async def submit_training_dataset(
    background_tasks: BackgroundTasks, dataset: UploadFile = File(...)
) -> JSONResponse:
    """上传脱敏 JSONL 训练集并创建异步本地模型训练任务。"""
    filename = Path(dataset.filename or "training.jsonl").name
    if not filename.lower().endswith((".jsonl", ".ndjson")):
        raise HTTPException(status_code=415, detail="仅接受 .jsonl 或 .ndjson 格式训练数据")
    raw_dataset = await dataset.read(settings.max_training_upload_bytes + 1)
    if not raw_dataset:
        raise HTTPException(status_code=400, detail="上传的训练数据文件为空")
    if len(raw_dataset) > settings.max_training_upload_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"训练数据超过大小限制：最大 {settings.max_training_upload_bytes} 字节",
        )
    try:
        raw_dataset.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="训练数据必须是 UTF-8 编码 JSONL") from exc

    task_id = str(uuid.uuid4())
    task_path = settings.job_dir / "training" / task_id
    task_path.mkdir(mode=0o700, parents=True, exist_ok=False)
    dataset_path = task_path / "dataset.jsonl"
    dataset_path.write_bytes(raw_dataset)
    try:
        dataset_path.chmod(0o600)
    except OSError:
        logger.warning("无法调整训练数据文件权限: %s", dataset_path)
    training_store.create(task_id, filename, dataset_path, len(raw_dataset))
    background_tasks.add_task(_process_training_task, task_id)
    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content={
            "task_id": task_id,
            "status": "queued",
            "message": "训练数据已接收，正在后台训练本地模型。",
            "status_url": f"/api/v1/models/train/{task_id}",
        },
    )


@app.get("/api/v1/models/train/{task_id}", tags=["机器学习"])
def get_training_task(task_id: str) -> dict:
    """查询异步模型训练任务状态与训练摘要。"""
    task = training_store.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="未找到指定训练任务")
    return task
