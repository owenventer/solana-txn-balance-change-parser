# Solana Transaction Balance Change Parser
This is a parser for extracting the balance changes that happen within a Solana transaction. 

Each transfer found wil be returned in the following format: 
  ```
  {
    fromTokenAccount: '',
    toTokenAccount: '',
    fromUserAccount: '',
    toUserAccount: '',
    amount: '',
    mint: '',
    decimals: 0,
    uiAmount: 0
  }