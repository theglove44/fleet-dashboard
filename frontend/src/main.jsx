import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import MapConcepts from './MapConcepts.jsx'
import './tokens.css'
import './styles.css'
import '@xterm/xterm/css/xterm.css'

const showMapConcepts = new URLSearchParams(window.location.search).get('map-concepts') === '1'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {showMapConcepts ? <MapConcepts /> : <App />}
  </React.StrictMode>
)
