/* 端末内に保存する。Artifact版の window.storage と同じ形にしてあるので
   App.jsx 側は get / set を呼ぶだけでよい。 */
export const storage = {
  async get(key) {
    try {
      const value = localStorage.getItem(key);
      if (value === null) throw new Error("not found");
      return { key, value };
    } catch (e) {
      throw e;
    }
  },
  async set(key, value) {
    localStorage.setItem(key, value);
    return { key, value };
  },
  async remove(key) {
    localStorage.removeItem(key);
    return { key, deleted: true };
  },
};
