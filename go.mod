module apus

go 1.25

// La extensión de VS Code no es Go: sin esto, ./... entraría en su
// node_modules, que trae algún .go suelto.
ignore ./extension
