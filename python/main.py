import os

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])


def main() -> None:
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": "Hello, OpenAI"}],
    )
    print(response.choices[0].message.content)


if __name__ == "__main__":
    main()
