import os
from dataclasses import dataclass

from dotenv import load_dotenv
from openai import OpenAI, OpenAIError


@dataclass
class ModelGroups:
    text: list[str]
    image: list[str]
    other: list[str]


def classify_models(model_ids: list[str]) -> ModelGroups:
    """모델 ID의 이름 규칙을 이용해 용도별로 분류합니다."""

    image_models = []
    text_models = []
    other_models = []

    # 텍스트 생성 모델에서 제외할 특수 모델 이름
    non_text_keywords = (
        "image",
        "audio",
        "realtime",
        "transcribe",
        "tts",
        "whisper",
        "embedding",
        "moderation",
        "dall-e",
        "sora",
    )

    # 일반 텍스트 생성 또는 추론 모델의 대표 접두사
    text_prefixes = (
        "gpt-",
        "o1",
        "o3",
        "o4",
    )

    for model_id in model_ids:
        model_name = model_id.lower()

        # 이미지 생성 전용 모델
        if (
            model_name.startswith("gpt-image")
            or model_name.startswith("dall-e")
        ):
            image_models.append(model_id)

        # 일반 텍스트 생성 및 추론 모델
        elif (
            model_name.startswith(text_prefixes)
            and not any(
                keyword in model_name
                for keyword in non_text_keywords
            )
        ):
            text_models.append(model_id)

        else:
            other_models.append(model_id)

    return ModelGroups(
        text=sorted(text_models),
        image=sorted(image_models),
        other=sorted(other_models),
    )


def get_available_models() -> list[str]:
    """현재 API 키로 조회 가능한 모델 ID를 반환합니다."""
    load_dotenv()

    api_key = os.getenv("OPENAI_API_KEY")

    if not api_key:
        raise ValueError(
            "OPENAI_API_KEY가 설정되지 않았습니다. "
            ".env 파일이나 환경변수를 확인하세요."
        )

    client = OpenAI(api_key=api_key)

    try:
        response = client.models.list()
        return sorted(model.id for model in response.data)

    except OpenAIError as error:
        raise RuntimeError(
            f"모델 목록 조회 실패: {error}"
        ) from error


def print_group(title: str, models: list[str]) -> None:
    print(f"\n=== {title} ({len(models)}개) ===")

    if not models:
        print("해당 모델 없음")
        return

    for model_id in models:
        print(model_id)


if __name__ == "__main__":
    try:
        model_ids = get_available_models()
        groups = classify_models(model_ids)

        print(f"전체 조회 모델 수: {len(model_ids)}")

        print_group("TEXT MODELS", groups.text)
        print_group("IMAGE MODELS", groups.image)
        print_group("OTHER MODELS", groups.other)

    except Exception as error:
        print(f"오류 발생: {error}")