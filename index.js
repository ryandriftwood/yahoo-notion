import express from "express";

const app = express();

app.get("/", (req, res) => {
  res.send("OK - Yahoo/Notion sync service is running");
});

app.get("/callback/yahoo", (req, res) => {
  res.send("OK - Yahoo callback endpoint reached (we will add OAuth next)");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
