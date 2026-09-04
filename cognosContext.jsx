import { createContext, useContext } from 'react';

export const CognosContext = createContext(null);
export const useCognos = () => useContext(CognosContext);
