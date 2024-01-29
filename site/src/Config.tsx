const config = await fetch('./config.json').then((response) => response.json());
export default config;
