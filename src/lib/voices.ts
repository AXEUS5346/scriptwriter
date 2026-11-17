export const VOICES = [
  'Ahana', 'Vaidehi', 'Malini', 'Charvi', 'Jahnavi', 'Anirban', 'Nakul', 'Vasant',
  'Siddhant', 'Satvik', 'Abhay', 'Nivedita', 'Ishwari', 'Ritvik', 'Vrinda', 'Sreekar',
  'Kayal', 'Shaunak', 'Akshat', 'Tanushree',
] as const;

export type Voice = (typeof VOICES)[number];
export type Speaker = 'questioner' | 'answerer';
