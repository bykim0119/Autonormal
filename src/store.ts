import fs from 'fs';
import path from 'path';

export interface Message {
  role: string;
  content: string;
}

export interface UserData {
  preferred_model: string | null;
  history: Message[];
  settings: Record<string, unknown>;
}

const HISTORY_LIMIT = 20;
const DEFAULT_DATA: UserData = { preferred_model: null, history: [], settings: {} };

export function createStore(dataDir: string) {
  function getUserData(userId: string): UserData {
    const filePath = path.join(dataDir, `${userId}.json`);
    if (!fs.existsSync(filePath)) return { ...DEFAULT_DATA, history: [], settings: {} };
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as UserData;
  }

  function saveUserData(userId: string, data: UserData): void {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, `${userId}.json`), JSON.stringify(data, null, 2));
  }

  function setPreferredModel(userId: string, model: string | null): void {
    const data = getUserData(userId);
    data.preferred_model = model;
    saveUserData(userId, data);
  }

  function appendHistory(userId: string, role: string, content: string): void {
    const data = getUserData(userId);
    data.history.push({ role, content });
    if (data.history.length > HISTORY_LIMIT) {
      data.history = data.history.slice(-HISTORY_LIMIT);
    }
    saveUserData(userId, data);
  }

  function updateSetting(userId: string, key: string, value: unknown): void {
    const data = getUserData(userId);
    data.settings[key] = value;
    saveUserData(userId, data);
  }

  return { getUserData, saveUserData, setPreferredModel, appendHistory, updateSetting };
}

// 기본 인스턴스 (프로덕션용)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
export const store = createStore(DATA_DIR);
