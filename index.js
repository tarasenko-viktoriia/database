const express = require('express');
const fs = require("node:fs");

const { graphqlHTTP } = require('express-graphql');
const { buildSchema } = require('graphql');
const multer  = require('multer');

const PUBLIC_PATH = "public"
const UPLOADS_PATH = 'uploads'
const upload = multer({ dest: `${PUBLIC_PATH}/${UPLOADS_PATH}`});

const bcrypt = require('bcrypt');
const saltRounds = 10;

const jwt = require('jsonwebtoken');
const JWT_SECRET = "TestSecret";

const { Sequelize, where } = require('sequelize');
const cors = require('cors');


const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.post('/upload', upload.single("file"), async (req, res) => {
    const signedData = jwtCheck(req)
    if (!signedData){
        res.status(403).end("Files can't uploaded anonimously")
        return
    }
    if (req.file){
        console.log('FILE UPLOAD', req.file)

        const {originalname, mimetype, filename, path, size} = req.file
        const {userId} = signedData

        const newFile = await File.create({originalname, mimetype, filename, path, size, userId})
        const {id, url} = newFile
        res.send({id, url})
    }
    else {
        res.status(502).end("Error")
    }
})

const port = 4000;

const sequelize = new Sequelize("test", "root", "123123", {
    host: 'localhost',
    dialect: 'mysql'
});

class File extends Sequelize.Model {
    get user() {
        return this.getUser();
    }
    get playlist(){
        return this.getPlaylist()
    }
    get url(){
        return `/${UPLOADS_PATH}/${this.filename}`
    }
}

File.init({
    originalname: Sequelize.STRING,
    mimetype: Sequelize.STRING,
    filename: Sequelize.STRING,
    path: Sequelize.STRING,
    size: Sequelize.INTEGER,
    isAvatar: Sequelize.BOOLEAN,
}, { sequelize, modelName: 'file' });

class User extends Sequelize.Model {
    get playlists(){
        return this.getPlaylists();
    }
    get files(){
        return this.getFiles()
    }
    get avatars(){
        return this.getFiles({where: {isAvatar:true}})
    }
}
User.init({
    login: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
    },
    nick: Sequelize.STRING,
    avatarId: Sequelize.INTEGER,
    password: Sequelize.STRING,
}, { sequelize, modelName: 'user' });

User.hasMany(File);
File.belongsTo(User);

class Playlist extends Sequelize.Model {
    get user() {
        return this.getUser();
    }
    get files(){
        return this.getFiles()
    }
}

Playlist.init({
    title: Sequelize.STRING
}, { sequelize, modelName: 'playlist' });

User.hasMany(Playlist)
Playlist.belongsTo(User)

Playlist.hasMany(File);
File.belongsTo(Playlist);

;(async () => {
    try {
        await sequelize.authenticate();
        console.log('Connection has been established successfully.');
    } catch (error) {
        console.error('Unable to connect to the database:', error);
        process.exit()    
    }

    await sequelize.sync()
})()

const schema = buildSchema(`
    type Query {
        login(login: String!, password: String!): String
        getUser(id: ID!): User
        getPlaylist(id:ID!):Playlist
        getPlaylists:[Playlist]
    }

    type Mutation {
        register(login: String!, password: String!): User
        addPlaylist(playlist: PlaylistInput):Playlist
        updatePlaylist(id: ID, playlist: PlaylistInput): Playlist
        updateUserNick(id: ID!, nick: String!): User
        setAvatar(avatarId: ID):File
    }

    type User {
        id: ID
        createdAt: String
        login: String
        nick: String
        files: [File]
        avatars: [File]
        playlists: [Playlist]
    }

    type Playlist {
        id: ID,
        userId: Int,
        title: String,
        createdAt: String,
        updatedAt: String,

        user:User,
        files: [File]
    }

    input PlaylistInput {
        title: String,
        fileIds: [ID]
    }
    
    type File{
        id: ID,
        originalname: String,
        mimetype: String,
        filename: String,
        path: String,
        size: String,
        isAvatar: Boolean,

        url: String,
        user: User,
        playlist: Playlist
    }
`);

const root = {
    async register({ login, password }) {
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        return await User.create({ login, password: hashedPassword });
    },
    async login({ login, password }) {
        const user = await User.findOne({ where: { login } });
        if (!user || !(await bcrypt.compare(password, user.password))) return null;
        const token = jwt.sign({ userId: user.id, login: user.login }, JWT_SECRET);
        return token;
    },
    async getUser({ id }) {
        return await User.findByPk(id);
    },
    async updateUserNick({ id, nick }) {
        try {
            const user = await User.findByPk(id);
            if (!user) {
                throw new Error('User not found');
            }
            user.nick = nick;
            await user.save();
            return user;
        } catch (error) {
            throw new Error(`Error updating nickname: ${error.message}`);
        }
    },
    async setAvatar({avatarId}, {user}){
        if (!user) return null
        if (!(await user.hasFile(avatarId))) return null

        const file = await File.findByPk(avatarId)
        file.isAvatar = true
        return await file.save()
    },
    async getPlaylist({id}, {user}){

        return await Playlist.findByPk(id)
    },
    async getPlaylists(){
        return await Playlist.findAll({order: ['id']})
    },
    async addPlaylist({playlist: {fileIds, ...playlist}}, {user}){
        if (!user) return null

        console.log(fileIds)

        const newPlaylist = await user.createPlaylist({...playlist})
        if (!(await user.hasFiles(fileIds))) return null

        await newPlaylist.setFiles(fileIds) 
        return newPlaylist
    },
    async updatePlaylist({id, playlist: {fileIds, ...playlist}}, {user}){
        if (!user) return null
        const playlistToEdit = await Playlist.findByPk(id)
        if (!playlistToEdit || playlistToEdit.userId !== user.id) return null
        
        if (!(await user.hasFiles(fileIds))) return null

        Object.assign(playlistToEdit, playlist)
        await playlistToEdit.setFiles(fileIds)

        await playlistToEdit.save()
        return playlistToEdit
    },
    async deletePlaylist({ id }, { user }) {
        if (!user) return null;
        const playlist = await Playlist.findByPk(id);
        if (!playlist || playlist.userId !== user.id) return null;
        await playlist.destroy();
        return { id };
      },
};

const jwtCheck = req => {
    if (!req?.headers?.authorization || !req.headers.authorization.startsWith('Bearer ')) return null;
    
    const tokenToCheck = req.headers.authorization.slice("Bearer ".length);
    try {
        const signedData = jwt.verify(tokenToCheck, JWT_SECRET);
        return signedData;
    } catch (e) {
        console.log('JWT VERIFY ERROR', e);
    }
    return null;
};

app.use('/graphql', graphqlHTTP(async req => {
    const signedData = jwtCheck(req);
    const user = signedData && await User.findByPk(signedData.userId);

    return {
        schema: schema,
        rootValue: root,
        graphiql: true,
        context: { user },
    };
}));

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});

// Тест