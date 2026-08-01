# LALA

개발 에이전트 해커톤 프로젝트. 주제는 아직 미정입니다.

## 구조

```
.
├── python/   # Python 에이전트 스캐폴드
├── node/     # Node.js/TypeScript 에이전트 스캐폴드
└── .env.example
```

## 시작하기

### 공통

```bash
cp .env.example .env
# .env에 OPENAI_API_KEY 채워넣기
```

### Python

```bash
cd python
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python main.py
```

### Node/TypeScript

```bash
cd node
npm install
npm run dev
```
