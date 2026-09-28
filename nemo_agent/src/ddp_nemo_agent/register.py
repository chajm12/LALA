"""Register the DDP PARK SAJANG HTTP routes as NeMo Agent Toolkit tools."""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from pydantic import Field


def _parse_payload(input_message: str) -> dict[str, Any]:
    try:
        value = json.loads(input_message)
    except json.JSONDecodeError:
        return {"keyword": input_message}

    if isinstance(value, dict):
        return value
    return {"keyword": input_message}


class DdpApiToolConfig(FunctionBaseConfig, name="ddp_api_tool"):
    route: str = Field(description="Next.js API route, for example /api/trend")
    description: str = "DDP PARK SAJANG API Tool"
    base_url: str = "http://localhost:3000"
    timeout_seconds: float = 180.0


@register_function(config_type=DdpApiToolConfig)
async def ddp_api_tool(config: DdpApiToolConfig, _builder: Any):
    async def _call(input_message: str) -> str:
        payload = _parse_payload(input_message)
        base_url = os.getenv("DDP_APP_URL", config.base_url).rstrip("/")
        url = f"{base_url}{config.route}"

        async with httpx.AsyncClient(timeout=config.timeout_seconds) as client:
            response = await client.post(url, json=payload)
            response.raise_for_status()
            return response.text

    yield FunctionInfo.from_fn(_call, description=config.description)
